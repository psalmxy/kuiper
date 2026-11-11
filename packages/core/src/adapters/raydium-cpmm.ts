import { createHash } from "node:crypto";
import { PublicKey, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { ceilDiv, floorDiv, readU64, tokenAccountAmount, u64Le } from "../math/u64.js";
import type { AccountMap, Amm, Quote, QuoteParams, SwapParams } from "../types.js";

/**
 * Raydium CPMM (CP-Swap) — native adapter, no SDK.
 * Layouts and math ported 1:1 from github.com/raydium-io/raydium-cp-swap
 * (states/pool.rs, states/config.rs, curve/calculator.rs, curve/fees.rs).
 */
export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const FEE_DENOMINATOR = 1_000_000n;

const anchorDisc = (ns: "global" | "account", name: string) =>
  createHash("sha256").update(`${ns}:${name}`).digest().subarray(0, 8);

export const SWAP_BASE_INPUT_DISCRIMINATOR = anchorDisc("global", "swap_base_input");
export const POOL_STATE_DISCRIMINATOR = anchorDisc("account", "PoolState");

export const [CPMM_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault_and_lp_mint_auth_seed")],
  RAYDIUM_CPMM_PROGRAM_ID,
);

export interface CpmmPoolState {
  ammConfig: PublicKey;
  token0Vault: PublicKey;
  token1Vault: PublicKey;
  token0Mint: PublicKey;
  token1Mint: PublicKey;
  token0Program: PublicKey;
  token1Program: PublicKey;
  observationKey: PublicKey;
  status: number;
  mint0Decimals: number;
  mint1Decimals: number;
  protocolFees0: bigint;
  protocolFees1: bigint;
  fundFees0: bigint;
  fundFees1: bigint;
  openTime: bigint;
  creatorFeeOn: number; // 0 BothToken, 1 OnlyToken0, 2 OnlyToken1
  enableCreatorFee: boolean;
  creatorFees0: bigint;
  creatorFees1: bigint;
}

export interface CpmmAmmConfig {
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  creatorFeeRate: bigint;
}

const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));

export function decodeCpmmPool(data: Buffer): CpmmPoolState {
  if (data.length < 637) throw new Error(`CPMM pool too small: ${data.length}`);
  if (!data.subarray(0, 8).equals(POOL_STATE_DISCRIMINATOR)) throw new Error("not a CPMM PoolState");
  return {
    ammConfig: pk(data, 8),
    token0Vault: pk(data, 72),
    token1Vault: pk(data, 104),
    token0Mint: pk(data, 168),
    token1Mint: pk(data, 200),
    token0Program: pk(data, 232),
    token1Program: pk(data, 264),
    observationKey: pk(data, 296),
    status: data.readUInt8(329),
    mint0Decimals: data.readUInt8(331),
    mint1Decimals: data.readUInt8(332),
    protocolFees0: readU64(data, 341),
    protocolFees1: readU64(data, 349),
    fundFees0: readU64(data, 357),
    fundFees1: readU64(data, 365),
    openTime: readU64(data, 373),
    creatorFeeOn: data.readUInt8(389),
    enableCreatorFee: data.readUInt8(390) !== 0,
    creatorFees0: readU64(data, 397),
    creatorFees1: readU64(data, 405),
  };
}

export function decodeCpmmConfig(data: Buffer): CpmmAmmConfig {
  return {
    tradeFeeRate: readU64(data, 12),
    protocolFeeRate: readU64(data, 20),
    fundFeeRate: readU64(data, 28),
    creatorFeeRate: readU64(data, 108),
  };
}

/** Port of `CurveCalculator::swap_base_input` (fees + constant product). */
export function cpmmSwapBaseInput(args: {
  amountIn: bigint;
  inputReserve: bigint;
  outputReserve: bigint;
  tradeFeeRate: bigint;
  creatorFeeRate: bigint;
  creatorFeeOnInput: boolean;
}): { amountOut: bigint; tradeFee: bigint; creatorFee: bigint } {
  const { amountIn, inputReserve, outputReserve, tradeFeeRate, creatorFeeRate, creatorFeeOnInput } = args;
  let creatorFee = 0n;
  let tradeFee: bigint;
  let inLessFees: bigint;
  if (creatorFeeOnInput) {
    const totalFee = ceilDiv(amountIn, tradeFeeRate + creatorFeeRate, FEE_DENOMINATOR);
    creatorFee = tradeFeeRate + creatorFeeRate === 0n ? 0n : floorDiv(totalFee, creatorFeeRate, tradeFeeRate + creatorFeeRate);
    tradeFee = totalFee - creatorFee;
    inLessFees = amountIn - totalFee;
  } else {
    tradeFee = ceilDiv(amountIn, tradeFeeRate, FEE_DENOMINATOR);
    inLessFees = amountIn - tradeFee;
  }
  if (inLessFees <= 0n) return { amountOut: 0n, tradeFee, creatorFee };
  const swapped = (inLessFees * outputReserve) / (inputReserve + inLessFees);
  let amountOut = swapped;
  if (!creatorFeeOnInput) {
    creatorFee = ceilDiv(swapped, creatorFeeRate, FEE_DENOMINATOR);
    amountOut = swapped - creatorFee;
  }
  return { amountOut, tradeFee, creatorFee };
}

export class RaydiumCpmmAmm implements Amm {
  readonly label = "Raydium CPMM";
  readonly programId = RAYDIUM_CPMM_PROGRAM_ID;
  readonly amountInOffset = 8; // [disc][amount_in u64]...
  private pool: CpmmPoolState;
  private config?: CpmmAmmConfig;
  private vault0?: bigint;
  private vault1?: bigint;

  constructor(readonly key: PublicKey, poolAccount: AccountInfo<Buffer>) {
    this.pool = decodeCpmmPool(poolAccount.data);
  }

  reserveMints() {
    return [this.pool.token0Mint, this.pool.token1Mint];
  }

  accountsToUpdate() {
    return [this.key, this.pool.ammConfig, this.pool.token0Vault, this.pool.token1Vault];
  }

  update(accounts: AccountMap) {
    const poolAcc = accounts.get(this.key.toBase58());
    if (poolAcc) this.pool = decodeCpmmPool(poolAcc.data);
    const cfg = accounts.get(this.pool.ammConfig.toBase58());
    if (cfg) this.config = decodeCpmmConfig(cfg.data);
    const v0 = accounts.get(this.pool.token0Vault.toBase58());
    const v1 = accounts.get(this.pool.token1Vault.toBase58());
    if (v0) this.vault0 = tokenAccountAmount(v0.data);
    if (v1) this.vault1 = tokenAccountAmount(v1.data);
  }

  isActive() {
    if (!this.config || this.vault0 === undefined || this.vault1 === undefined) return false;
    const swapDisabled = (this.pool.status & (1 << 2)) !== 0; // PoolStatusBitIndex::Swap
    const notOpen = BigInt(Math.floor(Date.now() / 1000)) < this.pool.openTime;
    // v1: Token-2022 transfer-fee handling not implemented → skip those pools rather than misquote.
    const t22 = this.pool.token0Program.equals(TOKEN_2022_PROGRAM_ID) || this.pool.token1Program.equals(TOKEN_2022_PROGRAM_ID);
    return !swapDisabled && !notOpen && !t22;
  }

  /** Reserves exclude protocol/fund/creator fees that sit in the vaults (`vault_amount_without_fee`). */
  reserves(): [bigint, bigint] {
    const p = this.pool;
    return [
      (this.vault0 ?? 0n) - p.protocolFees0 - p.fundFees0 - p.creatorFees0,
      (this.vault1 ?? 0n) - p.protocolFees1 - p.fundFees1 - p.creatorFees1,
    ];
  }

  private direction(inputMint: PublicKey): "zeroForOne" | "oneForZero" {
    if (inputMint.equals(this.pool.token0Mint)) return "zeroForOne";
    if (inputMint.equals(this.pool.token1Mint)) return "oneForZero";
    throw new Error(`mint ${inputMint.toBase58()} not in pool ${this.key.toBase58()}`);
  }

  quote({ inputMint, amount }: QuoteParams): Quote {
    if (!this.config) throw new Error("CPMM pool not loaded");
    const dir = this.direction(inputMint);
    const [r0, r1] = this.reserves();
    const creatorFeeOnInput =
      this.pool.creatorFeeOn === 0 ||
      (this.pool.creatorFeeOn === 1 && dir === "zeroForOne") ||
      (this.pool.creatorFeeOn === 2 && dir === "oneForZero");
    const res = cpmmSwapBaseInput({
      amountIn: amount,
      inputReserve: dir === "zeroForOne" ? r0 : r1,
      outputReserve: dir === "zeroForOne" ? r1 : r0,
      tradeFeeRate: this.config.tradeFeeRate,
      creatorFeeRate: this.pool.enableCreatorFee ? this.config.creatorFeeRate : 0n,
      creatorFeeOnInput,
    });
    return { inAmount: amount, outAmount: res.amountOut, feeAmount: res.tradeFee, feeMint: inputMint };
  }

  swapInstructions(p: SwapParams): TransactionInstruction[] {
    const dir = this.direction(p.inputMint);
    const z = dir === "zeroForOne";
    const pool = this.pool;
    const keys = [
      { pubkey: p.user, isSigner: true, isWritable: false },
      { pubkey: CPMM_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: pool.ammConfig, isSigner: false, isWritable: false },
      { pubkey: this.key, isSigner: false, isWritable: true },
      { pubkey: p.userSourceTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.userDestinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: z ? pool.token0Vault : pool.token1Vault, isSigner: false, isWritable: true },
      { pubkey: z ? pool.token1Vault : pool.token0Vault, isSigner: false, isWritable: true },
      { pubkey: z ? pool.token0Program : pool.token1Program, isSigner: false, isWritable: false },
      { pubkey: z ? pool.token1Program : pool.token0Program, isSigner: false, isWritable: false },
      { pubkey: z ? pool.token0Mint : pool.token1Mint, isSigner: false, isWritable: false },
      { pubkey: z ? pool.token1Mint : pool.token0Mint, isSigner: false, isWritable: false },
      { pubkey: pool.observationKey, isSigner: false, isWritable: true },
    ];
    const data = Buffer.concat([SWAP_BASE_INPUT_DISCRIMINATOR, u64Le(p.inAmount), u64Le(p.minOutAmount)]);
    return [new TransactionInstruction({ programId: RAYDIUM_CPMM_PROGRAM_ID, keys, data })];
  }
}
