import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { applySlippage } from "./math/u64.js";
import { buildRouterInstruction, type RouterLegIx } from "./router-program.js";
import type { Route } from "./router.js";

/** Rough per-leg compute budgets; the API right-sizes from simulation anyway. */
const CU_PER_LEG: Record<string, number> = {
  "Raydium CPMM": 90_000,
  "Orca Whirlpool": 160_000,
  "Meteora DLMM": 200_000,
};
const CU_BASE = 60_000;
const CU_ROUTER = 40_000;

export interface PlatformFee {
  /** Fee in input-token base units (already deducted from route.inAmount by the caller). */
  amount: bigint;
  /** For SOL input: the fee wallet. For SPL input: the fee wallet's existing token account for that mint. */
  destination: PublicKey;
  /** Needed for transfer_checked on SPL input. */
  inputDecimals: number;
}

export interface BuildSwapArgs {
  route: Route;
  user: PublicKey;
  slippageBps: number;
  /** Token program (SPL Token or Token-2022) for every mint the route touches, keyed by base58 mint. */
  tokenPrograms: Map<string, PublicKey>;
  priorityMicroLamports?: number;
  platformFee?: PlatformFee;
  /** Required for multi-hop routes. */
  routerProgramId?: PublicKey;
}

/**
 * Instruction list for a Kuiper-routed swap:
 *   compute budget → platform fee → ATAs / wSOL wrap → swap(s) → unwrap.
 * Single-hop routes call the DEXes directly (each leg with its own min-out, atomic in one tx).
 * Multi-hop routes go through the Kuiper router program, which feeds real intermediate amounts
 * between hops and enforces one final min-out.
 */
export async function buildKuiperSwapInstructions(a: BuildSwapArgs): Promise<TransactionInstruction[]> {
  const { route, user } = a;
  const prog = (m: PublicKey) => {
    const p = a.tokenPrograms.get(m.toBase58());
    if (!p) throw new Error(`token program unknown for ${m.toBase58()}`);
    return p;
  };
  const ata = (m: PublicKey) => getAssociatedTokenAddressSync(m, user, true, prog(m));
  const mints = [route.inputMint, ...route.hops.map((h) => h.outputMint)];
  const slots = mints.map(ata);
  const legs = route.hops.flatMap((h) => h.legs);

  const cu = CU_BASE + (route.hops.length > 1 ? CU_ROUTER : 0) + legs.reduce((s, l) => s + (CU_PER_LEG[l.amm.label] ?? 200_000), 0);
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: cu })];
  if (a.priorityMicroLamports) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: a.priorityMicroLamports }));

  ixs.push(...platformFeeInstructions({ user, inputMint: route.inputMint, inputTokenProgram: prog(route.inputMint), fee: a.platformFee }));

  const inIsSol = route.inputMint.equals(NATIVE_MINT);
  if (inIsSol) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(user, slots[0]!, user, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: user, toPubkey: slots[0]!, lamports: route.inAmount }),
      createSyncNativeInstruction(slots[0]!),
    );
  }
  for (let i = 1; i < mints.length; i++) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, slots[i]!, user, mints[i]!, prog(mints[i]!)));
  }

  if (route.hops.length === 1) {
    for (const leg of legs) {
      ixs.push(
        ...(await leg.amm.swapInstructions({
          user,
          inputMint: route.inputMint,
          outputMint: route.outputMint,
          userSourceTokenAccount: slots[0]!,
          userDestinationTokenAccount: slots[1]!,
          inAmount: leg.inAmount,
          minOutAmount: applySlippage(leg.outAmount, a.slippageBps),
        })),
      );
    }
  } else {
    if (!a.routerProgramId) throw new Error("multi-hop route needs the Kuiper router program (set KUIPER_ROUTER_PROGRAM_ID)");
    const routerLegs: RouterLegIx[] = [];
    for (const [h, hop] of route.hops.entries()) {
      for (const leg of hop.legs) {
        const legIxs = await leg.amm.swapInstructions({
          user,
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
          userSourceTokenAccount: slots[h]!,
          userDestinationTokenAccount: slots[h + 1]!,
          inAmount: leg.inAmount,
          minOutAmount: 0n, // the router enforces one final min-out
        });
        if (legIxs.length !== 1) throw new Error(`${leg.amm.label} produced ${legIxs.length} instructions; router needs exactly 1`);
        const pct = Number((leg.inAmount * 100n) / hop.inAmount);
        routerLegs.push({ inputSlot: h, outputSlot: h + 1, percent: Math.min(100, Math.max(1, pct)), amountOffset: leg.amm.amountInOffset, ix: legIxs[0]! });
      }
    }
    ixs.push(
      buildRouterInstruction({
        programId: a.routerProgramId,
        user,
        slots,
        inAmount: route.inAmount,
        minOut: applySlippage(route.outAmount, a.slippageBps),
        legs: routerLegs,
      }),
    );
  }

  // Unwrap any wSOL the route touched (input leftovers, SOL in the middle, SOL out).
  mints.forEach((m, i) => {
    if (m.equals(NATIVE_MINT)) ixs.push(createCloseAccountInstruction(slots[i]!, user, user));
  });
  return ixs;
}

/**
 * Fee transfer from the user's input, used for both Kuiper and Jupiter routes so the
 * comparison between them is on identical net amounts.
 * SOL input → lamports straight to the fee wallet. SPL input → transfer_checked to the fee token account.
 */
export function platformFeeInstructions(a: {
  user: PublicKey;
  inputMint: PublicKey;
  inputTokenProgram: PublicKey;
  fee?: PlatformFee;
}): TransactionInstruction[] {
  if (!a.fee || a.fee.amount <= 0n) return [];
  if (a.inputMint.equals(NATIVE_MINT)) {
    return [SystemProgram.transfer({ fromPubkey: a.user, toPubkey: a.fee.destination, lamports: a.fee.amount })];
  }
  const src = getAssociatedTokenAddressSync(a.inputMint, a.user, true, a.inputTokenProgram);
  return [
    createTransferCheckedInstruction(src, a.inputMint, a.fee.destination, a.user, a.fee.amount, a.fee.inputDecimals, [], a.inputTokenProgram),
  ];
}
