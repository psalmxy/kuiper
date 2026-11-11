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
import type { Route } from "./router.js";

/** Rough per-leg compute budgets; tune from simulation logs. */
const CU_PER_LEG: Record<string, number> = {
  "Raydium CPMM": 90_000,
  "Orca Whirlpool": 160_000,
  "Meteora DLMM": 200_000,
};
const CU_BASE = 60_000;

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
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  priorityMicroLamports?: number;
  platformFee?: PlatformFee;
}

/**
 * Builds the full instruction list for a Kuiper-routed swap:
 * compute budget → ATAs / wSOL wrap → platform fee → one swap ix per leg → unwrap.
 * Every leg carries its own min-out, so a split route is still all-or-nothing in one tx.
 */
export async function buildKuiperSwapInstructions(a: BuildSwapArgs): Promise<TransactionInstruction[]> {
  const { route, user } = a;
  const inIsSol = route.inputMint.equals(NATIVE_MINT);
  const outIsSol = route.outputMint.equals(NATIVE_MINT);
  const srcAta = getAssociatedTokenAddressSync(route.inputMint, user, true, a.inputTokenProgram);
  const dstAta = getAssociatedTokenAddressSync(route.outputMint, user, true, a.outputTokenProgram);

  const cu = CU_BASE + route.legs.reduce((s, l) => s + (CU_PER_LEG[l.amm.label] ?? 200_000), 0);
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: cu })];
  if (a.priorityMicroLamports) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: a.priorityMicroLamports }));

  // Platform fee, taken from the input before the swap.
  ixs.push(...platformFeeInstructions({ user, inputMint: route.inputMint, inputTokenProgram: a.inputTokenProgram, fee: a.platformFee }));

  if (inIsSol) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(user, srcAta, user, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: user, toPubkey: srcAta, lamports: route.inAmount }),
      createSyncNativeInstruction(srcAta),
    );
  }
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, dstAta, user, route.outputMint, a.outputTokenProgram));

  for (const leg of route.legs) {
    const legIxs = await leg.amm.swapInstructions({
      user,
      inputMint: route.inputMint,
      outputMint: route.outputMint,
      userSourceTokenAccount: srcAta,
      userDestinationTokenAccount: dstAta,
      inAmount: leg.inAmount,
      minOutAmount: applySlippage(leg.outAmount, a.slippageBps),
    });
    ixs.push(...legIxs);
  }

  if (inIsSol) ixs.push(createCloseAccountInstruction(srcAta, user, user));
  if (outIsSol) ixs.push(createCloseAccountInstruction(dstAta, user, user));
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
