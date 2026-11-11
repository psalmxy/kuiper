import type { AccountInfo, Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * Account snapshot handed to every adapter. Keyed by base58 address.
 * The pool cache fetches these in batches (getMultipleAccountsInfo / gRPC stream)
 * so adapters never touch the network inside `quote()` — same rule Jupiter
 * enforces on its `Amm` trait.
 */
export type AccountMap = Map<string, AccountInfo<Buffer> | null>;

export interface QuoteParams {
  inputMint: PublicKey;
  outputMint: PublicKey;
  /** Exact input amount in base units. (ExactOut is not supported in v1.) */
  amount: bigint;
}

export interface Quote {
  inAmount: bigint;
  outAmount: bigint;
  /** LP/trade fee charged by the pool, in `feeMint` base units. */
  feeAmount: bigint;
  feeMint: PublicKey;
  /** True when the pool ran out of liquidity in range (CLMM/DLMM). */
  notEnoughLiquidity?: boolean;
}

export interface SwapParams {
  user: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  userSourceTokenAccount: PublicKey;
  userDestinationTokenAccount: PublicKey;
  inAmount: bigint;
  minOutAmount: bigint;
}

/**
 * TypeScript mirror of Jupiter's `jupiter_amm_interface::Amm` trait.
 *
 * Lifecycle (driven by PoolCache):
 *   1. adapter constructed from the pool account (`fromAccount`)
 *   2. `accountsToUpdate()` → cache batches + fetches them
 *   3. `update(map)`         → adapter decodes + precomputes (heavy work goes here)
 *   4. `quote()`             → pure, synchronous, called many times per request
 *   5. `swapInstructions()`  → instructions for the user's transaction
 *
 * Adapters whose SDK can't be fed raw accounts may implement `refresh()` instead
 * of (or in addition to) steps 2-3. Prefer the batched path; it scales.
 */
export interface Amm {
  readonly key: PublicKey;
  readonly label: string;
  readonly programId: PublicKey;

  reserveMints(): PublicKey[];
  accountsToUpdate(): PublicKey[];
  update(accounts: AccountMap): void;
  refresh?(connection: Connection): Promise<void>;

  /** False when paused, not yet open, unsupported token extensions, or not loaded. */
  isActive(): boolean;
  quote(params: QuoteParams): Quote;
  swapInstructions(params: SwapParams): TransactionInstruction[] | Promise<TransactionInstruction[]>;
}

export type PoolKind = "raydium-cpmm" | "orca-whirlpool" | "meteora-dlmm";

export interface PoolConfig {
  kind: PoolKind;
  address: string;
  /** Optional human note, e.g. "SOL/USDC 0.04%" */
  note?: string;
}
