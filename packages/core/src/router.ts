import type { PublicKey } from "@solana/web3.js";
import type { Amm } from "./types.js";

export interface RouteLeg {
  amm: Amm;
  inAmount: bigint;
  outAmount: bigint;
  feeAmount: bigint;
}

export interface Route {
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmount: bigint;
  outAmount: bigint;
  legs: RouteLeg[];
}

export interface RouterOptions {
  /** Max pools one order is split across. Each extra leg costs ~compute + account space. */
  maxLegs?: number;
  /** Granularity of the greedy allocation pass. */
  chunks?: number;
  /** Only split if it beats the best single pool by at least this many bps. */
  minSplitImprovementBps?: number;
}

const DEFAULTS: Required<RouterOptions> = { maxLegs: 3, chunks: 20, minSplitImprovementBps: 2 };

/**
 * Direct-pair router with order splitting.
 *
 * Metis/Iris do multi-hop + multi-split over a full liquidity graph and use an
 * on-chain router program to chain hops atomically. Kuiper v1 deliberately
 * covers the case it can execute safely *without* its own program:
 *   - best single pool for A→B
 *   - split A→B across up to `maxLegs` pools (greedy marginal allocation,
 *     then golden-section refinement between the two largest legs — the same
 *     optimiser family Jupiter cites for Iris)
 * Multi-hop routes fall through to Jupiter until the Kuiper router program ships.
 */
export class Router {
  private readonly opts: Required<RouterOptions>;

  constructor(private readonly amms: () => Amm[], opts: RouterOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  candidates(inputMint: PublicKey, outputMint: PublicKey): Amm[] {
    return this.amms().filter((a) => {
      if (!a.isActive()) return false;
      const m = a.reserveMints();
      return m.some((x) => x.equals(inputMint)) && m.some((x) => x.equals(outputMint));
    });
  }

  private out(amm: Amm, inputMint: PublicKey, outputMint: PublicKey, amount: bigint): bigint {
    if (amount <= 0n) return 0n;
    const q = amm.quote({ inputMint, outputMint, amount });
    return q.notEnoughLiquidity ? 0n : q.outAmount;
  }

  bestRoute(inputMint: PublicKey, outputMint: PublicKey, amount: bigint): Route | null {
    if (amount <= 0n) return null;
    const pools = this.candidates(inputMint, outputMint);
    if (pools.length === 0) return null;

    // 1. Best single pool.
    const singles = pools
      .map((amm) => ({ amm, out: this.out(amm, inputMint, outputMint, amount) }))
      .filter((s) => s.out > 0n)
      .sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
    if (singles.length === 0) return null;
    const best = singles[0]!;
    let bestAlloc = new Map<Amm, bigint>([[best.amm, amount]]);
    let bestOut = best.out;

    // 2. Split across the top-N pools.
    const top = singles.slice(0, this.opts.maxLegs).map((s) => s.amm);
    if (top.length >= 2) {
      const alloc = this.greedySplit(top, inputMint, outputMint, amount);
      this.refineTopTwo(alloc, inputMint, outputMint);
      const splitOut = [...alloc].reduce((s, [amm, a]) => s + this.out(amm, inputMint, outputMint, a), 0n);
      const threshold = bestOut + (bestOut * BigInt(this.opts.minSplitImprovementBps)) / 10_000n;
      if (splitOut > threshold) {
        bestAlloc = alloc;
        bestOut = splitOut;
      }
    }

    const legs: RouteLeg[] = [...bestAlloc]
      .filter(([, a]) => a > 0n)
      .map(([amm, a]) => {
        const q = amm.quote({ inputMint, outputMint, amount: a });
        return { amm, inAmount: a, outAmount: q.outAmount, feeAmount: q.feeAmount };
      });
    return { inputMint, outputMint, inAmount: amount, outAmount: legs.reduce((s, l) => s + l.outAmount, 0n), legs };
  }

  /** Hand out `chunks` slices, each to the pool with the best marginal output. Optimal for concave curves. */
  private greedySplit(pools: Amm[], inM: PublicKey, outM: PublicKey, amount: bigint): Map<Amm, bigint> {
    const n = BigInt(this.opts.chunks);
    const chunk = amount / n;
    const alloc = new Map<Amm, bigint>(pools.map((p) => [p, 0n]));
    const outs = new Map<Amm, bigint>(pools.map((p) => [p, 0n]));
    for (let i = 0n; i < n; i++) {
      const size = i === n - 1n ? amount - chunk * (n - 1n) : chunk;
      let pick: Amm | null = null;
      let pickGain = -1n;
      let pickOut = 0n;
      for (const p of pools) {
        const next = this.out(p, inM, outM, alloc.get(p)! + size);
        const gain = next - outs.get(p)!;
        if (gain > pickGain) [pick, pickGain, pickOut] = [p, gain, next];
      }
      if (!pick) break;
      alloc.set(pick, alloc.get(pick)! + size);
      outs.set(pick, pickOut);
    }
    for (const [p, a] of alloc) if (a === 0n) alloc.delete(p);
    return alloc;
  }

  /** Golden-section search on the split ratio between the two biggest legs (others fixed). */
  private refineTopTwo(alloc: Map<Amm, bigint>, inM: PublicKey, outM: PublicKey) {
    const legs = [...alloc].sort((a, b) => (b[1] > a[1] ? 1 : -1));
    if (legs.length < 2) return;
    const [a, b] = [legs[0]![0], legs[1]![0]];
    const total = alloc.get(a)! + alloc.get(b)!;
    const f = (x: bigint) => this.out(a, inM, outM, x) + this.out(b, inM, outM, total - x);
    // bigint golden-section (u64 amounts overflow JS numbers); phi ≈ 0.618034
    const PHI_N = 618_034n;
    const PHI_D = 1_000_000n;
    let lo = 0n;
    let hi = total;
    for (let i = 0; i < 64 && hi - lo > 2n; i++) {
      const x1 = hi - ((hi - lo) * PHI_N) / PHI_D;
      const x2 = lo + ((hi - lo) * PHI_N) / PHI_D;
      if (f(x1) < f(x2)) lo = x1;
      else hi = x2;
    }
    const x = (lo + hi) / 2n;
    if (f(x) > f(alloc.get(a)!)) {
      alloc.set(a, x);
      alloc.set(b, total - x);
    }
  }
}
