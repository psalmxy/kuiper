import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it } from "vitest";
import { Router } from "../src/router.js";
import { KUIPER_ROUTER_PROGRAM_ID, ROUTE_DISCRIMINATOR, encodeRouteArgs } from "../src/router-program.js";
import { buildKuiperSwapInstructions } from "../src/tx-builder.js";
import type { Amm, Quote, QuoteParams, SwapParams } from "../src/types.js";

const [A, B, C] = [0, 1, 2].map(() => Keypair.generate().publicKey) as [PublicKey, PublicKey, PublicKey];
const DEX = Keypair.generate().publicKey;

class Cp implements Amm {
  readonly key = Keypair.generate().publicKey;
  readonly programId = DEX;
  readonly label = "Raydium CPMM";
  readonly amountInOffset = 8;
  constructor(private x: PublicKey, private y: PublicKey, private rx: bigint, private ry: bigint) {}
  reserveMints() { return [this.x, this.y]; }
  accountsToUpdate() { return []; }
  update() {}
  isActive() { return true; }
  quote({ inputMint, amount }: QuoteParams): Quote {
    const [ri, ro] = inputMint.equals(this.x) ? [this.rx, this.ry] : [this.ry, this.rx];
    const net = (amount * 9975n) / 10_000n;
    return { inAmount: amount, outAmount: (net * ro) / (ri + net), feeAmount: amount - net, feeMint: inputMint };
  }
  swapInstructions(p: SwapParams) {
    const data = Buffer.alloc(24);
    data.writeBigUInt64LE(p.inAmount, 8);
    data.writeBigUInt64LE(p.minOutAmount, 16);
    return [new TransactionInstruction({ programId: DEX, keys: [
      { pubkey: p.user, isSigner: true, isWritable: false },
      { pubkey: p.userSourceTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.userDestinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: this.key, isSigner: false, isWritable: true },
    ], data })];
  }
}

describe("multi-hop", () => {
  it("finds A→B→C when there is no direct pool and builds one router instruction", async () => {
    const ab = new Cp(A, B, 10n ** 12n, 10n ** 12n);
    const bc = new Cp(B, C, 10n ** 12n, 2n * 10n ** 12n);
    const router = new Router(() => [ab, bc]);
    expect(router.bestRoute(A, C, 10n ** 9n)).toBeNull(); // direct only
    const r = router.bestRoute(A, C, 10n ** 9n, { intermediates: [B] })!;
    expect(r.hops).toHaveLength(2);
    expect(r.hops[1]!.inAmount).toBe(r.hops[0]!.outAmount);

    const user = Keypair.generate().publicKey;
    const progs = new Map([A, B, C].map((m) => [m.toBase58(), TOKEN_PROGRAM_ID]));
    const ixs = await buildKuiperSwapInstructions({ route: r, user, slippageBps: 50, tokenPrograms: progs, routerProgramId: KUIPER_ROUTER_PROGRAM_ID });
    const routerIxs = ixs.filter((i) => i.programId.equals(KUIPER_ROUTER_PROGRAM_ID));
    expect(routerIxs).toHaveLength(1);
    const ix = routerIxs[0]!;
    expect(ix.data.subarray(0, 8).equals(ROUTE_DISCRIMINATOR)).toBe(true);
    expect(ix.data.readBigUInt64LE(8)).toBe(10n ** 9n);
    expect(ix.data.readBigUInt64LE(16)).toBe((r.outAmount * 9950n) / 10_000n); // single final min-out
    expect(ix.data.readUInt8(24)).toBe(3); // slots: A, B, C
    // user + 3 slots + 2 × (program + 4 accounts)
    expect(ix.keys).toHaveLength(1 + 3 + 2 * 5);
    // the DEX legs are not called directly — only via the router
    expect(ixs.some((i) => i.programId.equals(DEX))).toBe(false);
  });

  it("prefers 2-hop only when it beats direct", () => {
    const shallowAC = new Cp(A, C, 10n ** 7n, 2n * 10n ** 7n);
    const ab = new Cp(A, B, 10n ** 12n, 10n ** 12n);
    const bc = new Cp(B, C, 10n ** 12n, 2n * 10n ** 12n);
    const r = new Router(() => [shallowAC, ab, bc]).bestRoute(A, C, 10n ** 8n, { intermediates: [B] })!;
    expect(r.hops).toHaveLength(2);
    const small = new Router(() => [new Cp(A, C, 10n ** 12n, 2n * 10n ** 12n), ab, bc]).bestRoute(A, C, 10n ** 6n, { intermediates: [B] })!;
    expect(small.hops).toHaveLength(1);
  });

  it("encodes route args exactly as the Rust program's Borsh layout (fixture shared with programs/tests)", () => {
    const data = encodeRouteArgs(1000n, 900n, 3, [
      { inputSlot: 0, outputSlot: 1, percent: 60, accountsLen: 7, amountOffset: 8, data: Buffer.from([1, 2, 3]) },
      { inputSlot: 1, outputSlot: 2, percent: 100, accountsLen: 4, amountOffset: 9, data: Buffer.alloc(0) },
    ]);
    expect(data.toString("hex")).toBe(ROUTE_FIXTURE_HEX);
  });
});

export const ROUTE_FIXTURE_HEX = "e517cb977ae3ad2ae8030000000000008403000000000000030200000000013c0708000300000001020301026404090000000000";
