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

const connection = new Connection(env.RPC_URL, "confirmed");
const cache = new PoolCache(connection, pools as PoolConfig[]);
const router = new Router(() => cache.amms);
const jupiter = new JupiterClient(env.JUP_API_KEY);
const service = new SwapService(connection, cache, router, jupiter, {
  feeWallet: env.FEE_WALLET ? new PublicKey(env.FEE_WALLET) : undefined,
  feeBps: env.PLATFORM_FEE_BPS,
});

// ---------- serialisers (bigint → string) ----------
const routeJson = (r: Route | null) =>
  r && {
    inAmount: r.inAmount.toString(),
    outAmount: r.outAmount.toString(),
    legs: r.legs.map((l) => ({
      label: l.amm.label,
      pool: l.amm.key.toBase58(),
      inAmount: l.inAmount.toString(),
      outAmount: l.outAmount.toString(),
      feeAmount: l.feeAmount.toString(),
      percent: Number((l.inAmount * 10_000n) / r.inAmount) / 100,
    })),
  };
const jupJson = (j: JupBuildResponse | null) =>
  j && {
    inAmount: j.inAmount,
    outAmount: j.outAmount,
    legs: j.routePlan.map((p) => ({ label: p.swapInfo.label, pool: p.swapInfo.ammKey, inputMint: p.swapInfo.inputMint, outputMint: p.swapInfo.outputMint, percent: p.percent })),
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
