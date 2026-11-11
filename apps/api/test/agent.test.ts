import { Keypair, PublicKey } from "@solana/web3.js";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it } from "vitest";
import { DefiAgent } from "../src/agent/agent.js";
import { fromBaseUnits, toBaseUnits, type Preparer } from "../src/agent/preparer.js";
import { TicketStore } from "../src/agent/tickets.js";
import { checkToken } from "../src/agent/token-check.js";

describe("amount helpers", () => {
  it("round-trips human amounts", () => {
    expect(toBaseUnits("1.5", 9)).toBe(1_500_000_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
    expect(() => toBaseUnits("0.0000001", 6)).toThrow();
    expect(() => toBaseUnits("abc", 6)).toThrow();
    expect(fromBaseUnits(1_234_560_000n, 9)).toBe("1.23456");
  });
});

function mintAccount(opts: { mintAuthority?: PublicKey; freezeAuthority?: PublicKey; supply: bigint }) {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: opts.mintAuthority ? 1 : 0,
      mintAuthority: opts.mintAuthority ?? PublicKey.default,
      supply: opts.supply,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: opts.freezeAuthority ? 1 : 0,
      freezeAuthority: opts.freezeAuthority ?? PublicKey.default,
    },
    data,
  );
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
}

const fakeConn = (acc: ReturnType<typeof mintAccount>, holders: bigint[]) =>
  ({
    getAccountInfo: async () => acc,
    getTokenLargestAccounts: async () => ({ value: holders.map((h) => ({ amount: h.toString() })) }),
  }) as any;

describe("token safety check", () => {
  it("flags an unknown token with freeze + mint authority and concentrated supply as high risk", async () => {
    const auth = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey.toBase58();
    const r = await checkToken(fakeConn(mintAccount({ mintAuthority: auth, freezeAuthority: auth, supply: 1000n }), [900n, 50n]), mint);
    expect(r.risk).toBe("high");
    expect(r.flags.map((f) => f.text).join(" ")).toMatch(/freeze/);
    expect(r.flags.map((f) => f.text).join(" ")).toMatch(/mint more/);
  });

  it("treats a renounced, distributed token as low risk", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const r = await checkToken(fakeConn(mintAccount({ supply: 1_000_000n }), [50_000n, 40_000n, 30_000n]), mint);
    expect(r.risk).toBe("low");
  });

  it("does not penalise known issuers (USDC freeze authority is expected)", async () => {
    const auth = Keypair.generate().publicKey;
    const r = await checkToken(fakeConn(mintAccount({ mintAuthority: auth, freezeAuthority: auth, supply: 10n ** 12n }), [10n ** 11n]), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(r.risk).toBe("low");
    expect(r.symbol).toBe("USDC");
  });
});

describe("agent loop", () => {
  it("calls prepare_swap, returns the ticket, and never claims execution itself", async () => {
    const store = new TicketStore();
    const calls: any[] = [];
    const prep = {
      swap: async (p: any) => {
        calls.push(p);
        return store.create({
          kind: "swap", title: "Swap 1 SOL → USDC", summary: "s", details: [], tokenChecks: [],
          simulation: { ok: true, balanceChanges: [{ mint: "x", symbol: "USDC", delta: "+168.2" }] },
          warnings: [], transaction: "AA==", user: p.user, submit: { via: "rpc" },
        });
      },
    } as unknown as Preparer;

    const requests: any[] = [];
    const responses = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "prepare_swap", input: { input: "SOL", output: "USDC", amount: "1" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Your ticket is ready — approve it in your wallet." }] },
    ];
    const fakeClient = { messages: { create: async (req: any) => { requests.push(structuredClone(req)); return responses.shift(); } } } as any;
    const wallet = Keypair.generate().publicKey.toBase58();

    const out = await new DefiAgent("k", "model", prep, fakeClient).chat(undefined, "swap 1 SOL to USDC", wallet);
    expect(calls[0]).toMatchObject({ user: wallet, input: "SOL", output: "USDC", amount: "1" });
    expect(out.tickets).toHaveLength(1);
    expect(out.tickets[0]).not.toHaveProperty("refresh");
    expect(out.reply).toMatch(/approve/);
    const toolResult = requests[1].messages.at(-1).content[0];
    expect(toolResult.type).toBe("tool_result");
    expect(JSON.parse(toolResult.content).ticketId).toBe(out.tickets[0]!.id);
  });

  it("refuses wallet actions when no wallet is connected", async () => {
    const responses = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "prepare_stake", input: { amountSol: "2" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Connect your wallet first." }] },
    ];
    const requests: any[] = [];
    const fakeClient = { messages: { create: async (req: any) => { requests.push(structuredClone(req)); return responses.shift(); } } } as any;
    const out = await new DefiAgent("k", "m", {} as Preparer, fakeClient).chat(undefined, "stake 2 sol", undefined);
    expect(out.tickets).toHaveLength(0);
    const res = requests[1].messages.at(-1).content[0];
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/No wallet connected/);
  });
});
