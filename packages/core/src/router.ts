import type { PublicKey } from "@solana/web3.js";
import type { Amm } from "./types.js";

export interface RouteLeg {
  amm: Amm;
  inAmount: bigint;
  outAmount: bigint;
  feeAmount: bigint;
}

/** One token-to-token stage of a route, possibly split across several pools. */
export interface RouteHop {
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmount: bigint;
  outAmount: bigint;
  legs: RouteLeg[];
}

export interface Route {
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmount: bigint;
  outAmount: bigint;
  hops: RouteHop[];
}

export interface RouterOptions {
  /** Max pools one hop is split across. Each extra leg costs compute + account space. */
  maxLegs?: number;
  /** Granularity of the greedy allocation pass. */
  chunks?: number;
  /** Only split if it beats the best single pool by at least this many bps. */
  minSplitImprovementBps?: number;
  /** Only take a 2-hop route if it beats the best direct route by at least this many bps. */
  minHopImprovementBps?: number;
}

export interface RouteRequestOptions {
  /** Tokens allowed in the middle of a 2-hop route (e.g. SOL, USDC, USDT). Empty = direct only. */
  intermediates?: PublicKey[];
}

const DEFAULTS: Required<RouterOptions> = { maxLegs: 3, chunks: 20, minSplitImprovementBps: 2, minHopImprovementBps: 5 };

/**
 * Kuiper's off-chain router.
 *
 * - Direct A→B: best single pool, or a split across up to `maxLegs` pools (greedy marginal
 *   allocation, then golden-section refinement between the two largest legs — the optimiser
 *   family Jupiter cites for Iris).
 * - 2-hop A→X→B through a small set of hub tokens, each hop itself optionally split.
 *   Multi-hop routes need the Kuiper router program on-chain to pass hop 1's real output into hop 2.
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

  bestRoute(inputMint: PublicKey, outputMint: PublicKey, amount: bigint, req: RouteRequestOptions = {}): Route | null {
    if (amount <= 0n || inputMint.equals(outputMint)) return null;
    const direct = this.bestHop(inputMint, outputMint, amount);
    let best: Route | null = direct && { inputMint, outputMint, inAmount: amount, outAmount: direct.outAmount, hops: [direct] };

    for (const mid of req.intermediates ?? []) {
      if (mid.equals(inputMint) || mid.equals(outputMint)) continue;
      const h1 = this.bestHop(inputMint, mid, amount);
      if (!h1) continue;
      const h2 = this.bestHop(mid, outputMint, h1.outAmount);
      if (!h2) continue;
      const bar = best ? best.outAmount + (best.outAmount * BigInt(this.opts.minHopImprovementBps)) / 10_000n : 0n;
      if (h2.outAmount > bar) best = { inputMint, outputMint, inAmount: amount, outAmount: h2.outAmount, hops: [h1, h2] };
    }
    return best;
  }

  private out(amm: Amm, inputMint: PublicKey, outputMint: PublicKey, amount: bigint): bigint {
    if (amount <= 0n) return 0n;
    const q = amm.quote({ inputMint, outputMint, amount });
    return q.notEnoughLiquidity ? 0n : q.outAmount;
  }

  /** Best execution for a single token pair: one pool or a split. */
  bestHop(inputMint: PublicKey, outputMint: PublicKey, amount: bigint): RouteHop | null {
    if (amount <= 0n) return null;
    const pools = this.candidates(inputMint, outputMint);
    if (pools.length === 0) return null;

    const singles = pools
      .map((amm) => ({ amm, out: this.out(amm, inputMint, outputMint, amount) }))
      .filter((s) => s.out > 0n)
      .sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
    if (singles.length === 0) return null;
    const first = singles[0]!;
    let bestAlloc = new Map<Amm, bigint>([[first.amm, amount]]);
    const bestOut = first.out;

    const top = singles.slice(0, this.opts.maxLegs).map((s) => s.amm);
    if (top.length >= 2) {
      const alloc = this.greedySplit(top, inputMint, outputMint, amount);
      // Pools that run out of in-range liquidity can leave the order partly unallocated: no split then.
      const allocated = [...alloc.values()].reduce((a, b) => a + b, 0n);
      if (allocated !== amount) return this.single(first, inputMint, outputMint, amount);
      this.refineTopTwo(alloc, inputMint, outputMint);
      const splitOut = [...alloc].reduce((s, [amm, a]) => s + this.out(amm, inputMint, outputMint, a), 0n);
      if (splitOut > bestOut + (bestOut * BigInt(this.opts.minSplitImprovementBps)) / 10_000n) bestAlloc = alloc;
    }

    const legs: RouteLeg[] = [...bestAlloc]
      .filter(([, a]) => a > 0n)
      .map(([amm, a]) => {
        const q = amm.quote({ inputMint, outputMint, amount: a });
        return { amm, inAmount: a, outAmount: q.outAmount, feeAmount: q.feeAmount };
      });
    return { inputMint, outputMint, inAmount: amount, outAmount: legs.reduce((s, l) => s + l.outAmount, 0n), legs };
  }

  private single(s: { amm: Amm }, inputMint: PublicKey, outputMint: PublicKey, amount: bigint): RouteHop {
    const q = s.amm.quote({ inputMint, outputMint, amount });
    return { inputMint, outputMint, inAmount: amount, outAmount: q.outAmount, legs: [{ amm: s.amm, inAmount: amount, outAmount: q.outAmount, feeAmount: q.feeAmount }] };
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
