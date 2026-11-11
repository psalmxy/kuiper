import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { Router } from "../src/router.js";
import type { Amm, Quote, QuoteParams } from "../src/types.js";

const A = Keypair.generate().publicKey;
const B = Keypair.generate().publicKey;

/** Minimal constant-product pool for router tests. */
class FakeCpAmm implements Amm {
  readonly key = Keypair.generate().publicKey;
  readonly programId = PublicKey.default;
  constructor(readonly label: string, private ra: bigint, private rb: bigint, private feeBps = 25n, private active = true) {}
  reserveMints() { return [A, B]; }
  accountsToUpdate() { return []; }
  update() {}
  isActive() { return this.active; }
  quote({ inputMint, amount }: QuoteParams): Quote {
    const [x, y] = inputMint.equals(A) ? [this.ra, this.rb] : [this.rb, this.ra];
    const fee = (amount * this.feeBps + 9_999n) / 10_000n;
    const net = amount - fee;
    return { inAmount: amount, outAmount: (net * y) / (x + net), feeAmount: fee, feeMint: inputMint };
  }
  swapInstructions() { return []; }
}

describe("Router", () => {
  it("uses a single pool for small trades", () => {
    const deep = new FakeCpAmm("deep", 10n ** 12n, 10n ** 12n);
    const shallow = new FakeCpAmm("shallow", 10n ** 9n, 10n ** 9n);
    const r = new Router(() => [deep, shallow]).bestRoute(A, B, 1_000n)!;
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]!.amm).toBe(deep);
  });

  it("splits large trades across comparable pools and beats every single pool", () => {
    const p1 = new FakeCpAmm("p1", 10n ** 9n, 10n ** 9n);
    const p2 = new FakeCpAmm("p2", 8n * 10n ** 8n, 8n * 10n ** 8n, 30n);
    const amount = 2n * 10n ** 8n;
    const r = new Router(() => [p1, p2]).bestRoute(A, B, amount)!;
    const best1 = [p1, p2].map((p) => p.quote({ inputMint: A, outputMint: B, amount }).outAmount).reduce((a, b) => (a > b ? a : b));
    expect(r.legs).toHaveLength(2);
    expect(r.legs.reduce((s, l) => s + l.inAmount, 0n)).toBe(amount);
    expect(r.outAmount).toBeGreaterThan(best1);
  });

  it("golden-section refinement lands near the analytical optimum for identical pools", () => {
    const p1 = new FakeCpAmm("p1", 10n ** 9n, 10n ** 9n);
    const p2 = new FakeCpAmm("p2", 10n ** 9n, 10n ** 9n);
    const r = new Router(() => [p1, p2]).bestRoute(A, B, 4n * 10n ** 8n)!;
    const [l1, l2] = r.legs;
    const diff = l1!.inAmount > l2!.inAmount ? l1!.inAmount - l2!.inAmount : l2!.inAmount - l1!.inAmount;
    expect(diff * 1000n).toBeLessThan(4n * 10n ** 8n); // within 0.1% of a 50/50 split
  });

  it("handles u64-scale amounts without precision loss", () => {
    const big = 10n ** 18n;
    const p1 = new FakeCpAmm("p1", big * 5n, big * 5n);
    const p2 = new FakeCpAmm("p2", big * 4n, big * 4n);
    const r = new Router(() => [p1, p2]).bestRoute(A, B, big)!;
    expect(r.legs.reduce((s, l) => s + l.inAmount, 0n)).toBe(big);
    expect(r.outAmount).toBeGreaterThan(0n);
  });

  it("ignores inactive pools and returns null when nothing can fill", () => {
    const off = new FakeCpAmm("off", 10n ** 12n, 10n ** 12n, 25n, false);
    expect(new Router(() => [off]).bestRoute(A, B, 1_000n)).toBeNull();
    const ok = new FakeCpAmm("ok", 10n ** 9n, 10n ** 9n);
    expect(new Router(() => [off, ok]).bestRoute(A, B, 1_000n)!.legs[0]!.amm).toBe(ok);
  });
});
