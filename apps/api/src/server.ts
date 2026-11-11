import { serve } from "@hono/node-server";
import { PoolCache, Router, type PoolConfig, type Route } from "@kuiper/core";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { env } from "./env.js";
import { JupiterClient, type JupBuildResponse } from "./jupiter.js";
import pools from "./pools.json" with { type: "json" };
import { SwapService } from "./service.js";
import { DefiAgent } from "./agent/agent.js";
import { JupiterExtra } from "./agent/jupiter-extra.js";
import { Preparer } from "./agent/preparer.js";
import { TicketStore, ticketJson } from "./agent/tickets.js";

const connection = new Connection(env.RPC_URL, "confirmed");
const cache = new PoolCache(connection, pools as PoolConfig[]);
const router = new Router(() => cache.amms);
const jupiter = new JupiterClient(env.JUP_API_KEY);
const service = new SwapService(connection, cache, router, jupiter, {
  feeWallet: env.FEE_WALLET ? new PublicKey(env.FEE_WALLET) : undefined,
  feeBps: env.PLATFORM_FEE_BPS,
  routerProgramId: env.KUIPER_ROUTER_PROGRAM_ID ? new PublicKey(env.KUIPER_ROUTER_PROGRAM_ID) : undefined,
});

const tickets = new TicketStore();
const jupExtra = new JupiterExtra(env.JUP_API_KEY);
const preparer = new Preparer(connection, service, jupExtra, tickets);
const agent = env.ANTHROPIC_API_KEY ? new DefiAgent(env.ANTHROPIC_API_KEY, env.AGENT_MODEL, preparer) : null;

// ---------- serialisers (bigint → string) ----------
export const routeJson = (r: Route | null) =>
  r && {
    inAmount: r.inAmount.toString(),
    outAmount: r.outAmount.toString(),
    path: [r.inputMint, ...r.hops.map((h) => h.outputMint)].map((m) => m.toBase58()),
    legs: r.hops.flatMap((h, i) =>
      h.legs.map((l) => ({
        hop: i,
        label: l.amm.label,
        pool: l.amm.key.toBase58(),
        inputMint: h.inputMint.toBase58(),
        outputMint: h.outputMint.toBase58(),
        inAmount: l.inAmount.toString(),
        outAmount: l.outAmount.toString(),
        feeAmount: l.feeAmount.toString(),
        percent: Number((l.inAmount * 10_000n) / h.inAmount) / 100,
      })),
    ),
  };
export const jupJson = (j: JupBuildResponse | null) => {
  if (!j) return null;
  const path = [j.inputMint];
  for (const p of j.routePlan) if (path[path.length - 1] !== p.swapInfo.outputMint && p.swapInfo.outputMint !== j.outputMint) path.push(p.swapInfo.outputMint);
  path.push(j.outputMint);
  return {
    inAmount: j.inAmount,
    outAmount: j.outAmount,
    path,
    legs: j.routePlan.map((p) => ({
      hop: Math.max(0, path.indexOf(p.swapInfo.inputMint)),
      label: p.swapInfo.label,
      pool: p.swapInfo.ammKey,
      inputMint: p.swapInfo.inputMint,
      outputMint: p.swapInfo.outputMint,
      percent: p.percent,
    })),
  };
};

// ---------- validation ----------
const pubkey = z.string().refine((s) => {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}, "invalid public key");
const quoteSchema = z.object({
  inputMint: pubkey,
  outputMint: pubkey,
  amount: z.string().regex(/^\d+$/).transform(BigInt).refine((v) => v > 0n, "amount must be > 0"),
  slippageBps: z.coerce.number().int().min(1).max(5000).default(50),
  taker: pubkey.optional(),
});
const swapSchema = quoteSchema.extend({ taker: pubkey, source: z.enum(["kuiper", "jupiter"]).optional() });

// ---------- routes ----------
const app = new Hono();
app.use("*", cors({ origin: env.CORS_ORIGIN }));

app.onError((err, c) => {
  if (err instanceof z.ZodError) {
    return c.json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  }
  console.error(`[kuiper-api] ${c.req.method} ${c.req.path}: ${err.message}`);
  return c.json({ error: err.message, logs: (err as { logs?: string }).logs }, 400);
});

app.get("/health", (c) =>
  c.json({
    ok: true,
    pools: cache.amms.length,
    activePools: cache.amms.filter((a) => a.isActive()).length,
    lastRefreshMsAgo: cache.lastRefresh ? Date.now() - cache.lastRefresh : null,
    jupiterFallback: jupiter.enabled,
    multiHop: !!env.KUIPER_ROUTER_PROGRAM_ID,
    agent: !!agent,
  }),
);

app.get("/pools", (c) =>
  c.json(
    cache.amms.map((a) => ({
      label: a.label,
      address: a.key.toBase58(),
      mints: a.reserveMints().map((m) => m.toBase58()),
      active: a.isActive(),
    })),
  ),
);

app.get("/quote", async (c) => {
  const req = quoteSchema.parse(c.req.query());
  const q = await service.quote(req);
  return c.json({
    inAmount: q.inAmount.toString(),
    platformFee: q.feeAmount.toString(),
    netAmount: q.netAmount.toString(),
    best: q.best,
    kuiper: routeJson(q.kuiper),
    jupiter: jupJson(q.jupiter),
    jupiterError: q.jupiterError,
  });
});

app.post("/swap", async (c) => {
  const req = swapSchema.parse(await c.req.json());
  const s = await service.buildSwap(req);
  return c.json({
    ...s,
    inAmount: s.inAmount.toString(),
    feeAmount: s.feeAmount.toString(),
    outAmount: s.outAmount.toString(),
    minOutAmount: s.minOutAmount.toString(),
  });
});

/** Relay a signed tx with retries. (Swap to Jito / Jupiter /tx/v1/submit for better landing.) */
app.post("/send", async (c) => {
  const { signedTransaction } = z.object({ signedTransaction: z.string() }).parse(await c.req.json());
  const tx = VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64"));
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  return c.json({ signature });
});

// ---------- DeFi agent ----------
// The agent prepares tickets; it never signs. Execution = the user's wallet signing the ticket tx.
app.post("/agent/chat", async (c) => {
  if (!agent) return c.json({ error: "Agent disabled: set ANTHROPIC_API_KEY" }, 503);
  const body = z.object({ sessionId: z.string().optional(), message: z.string().min(1).max(2000), wallet: pubkey.optional() }).parse(await c.req.json());
  return c.json(await agent.chat(body.sessionId, body.message, body.wallet));
});

app.get("/agent/tickets/:id", (c) => {
  const t = tickets.get(c.req.param("id"));
  return t ? c.json(ticketJson(t)) : c.json({ error: "ticket not found" }, 404);
});

/** New blockhash + fresh quote/simulation for an expired or stale ticket. */
app.post("/agent/tickets/:id/refresh", async (c) => {
  const t = tickets.get(c.req.param("id"));
  if (!t?.refresh) return c.json({ error: "ticket not found" }, 404);
  const fresh = await t.refresh();
  return c.json(ticketJson(fresh));
});

app.post("/agent/tickets/:id/submit", async (c) => {
  const t = tickets.get(c.req.param("id"));
  if (!t) return c.json({ error: "ticket not found" }, 404);
  if (t.status !== "ready") return c.json({ error: `ticket is ${t.status}` }, 409);
  const { signedTransaction } = z.object({ signedTransaction: z.string() }).parse(await c.req.json());
  const tx = VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64"));
  // Wallets may append safety instructions, so we don't require byte equality — but it must be the
  // ticket owner's transaction, signed by them.
  if (tx.message.staticAccountKeys[0]?.toBase58() !== t.user) return c.json({ error: "signed by a different wallet" }, 400);
  if (tx.signatures[0]?.every((b) => b === 0)) return c.json({ error: "transaction is not signed" }, 400);

  let signature: string;
  if (t.submit.via === "jupiter-recurring") {
    const r = await jupExtra.recurringExecute(t.submit.requestId, signedTransaction);
    if (r.status !== "Success" || !r.signature) {
      t.status = "failed";
      return c.json({ error: r.error ?? "recurring order failed" }, 400);
    }
    signature = r.signature;
  } else {
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  }
  t.status = "submitted";
  t.signature = signature;
  return c.json({ signature, ticket: ticketJson(t) });
});

// ---------- boot ----------
const boot = async () => {
  try {
    await cache.init();
    cache.start(env.POOL_REFRESH_MS);
  } catch (e) {
    console.error(`[kuiper-api] pool cache init failed (${(e as Error).message}); retrying in 5s`);
    setTimeout(boot, 5000);
  }
};
void boot();
serve({ fetch: app.fetch, port: env.PORT }, (info) => console.log(`[kuiper-api] listening on :${info.port}`));

export { app };
