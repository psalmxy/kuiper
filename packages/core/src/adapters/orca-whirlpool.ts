import type { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Percentage } from "@orca-so/common-sdk";
import {
  ORCA_WHIRLPOOL_PROGRAM_ID,
  ParsableOracle,
  ParsableTickArray,
  ParsableWhirlpool,
  PDAUtil,
  SwapUtils,
  TickUtil,
  WhirlpoolContext,
  swapQuoteWithParams,
  WhirlpoolIx,
  type OracleData,
  type TickArray,
  type WhirlpoolData,
} from "@orca-so/whirlpools-sdk";
import { unpackMint } from "@solana/spl-token";
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo, type Connection, type TransactionInstruction } from "@solana/web3.js";
import type { AccountMap, Amm, Quote, QuoteParams, SwapParams } from "../types.js";

type MintInfo = ReturnType<typeof unpackMint> & { tokenProgram: PublicKey };
const NO_SLIPPAGE = Percentage.fromFraction(0, 1000);
const TICK_ARRAYS_PER_SIDE = 3;

/** Read-only Anchor program handle for building instructions (never signs). */
export function makeWhirlpoolProgram(connection: Connection) {
  const kp = Keypair.generate();
  const wallet = {
    publicKey: kp.publicKey,
    payer: kp,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  return WhirlpoolContext.from(connection, wallet).program;
}

/**
 * Orca Whirlpools (CLMM). Uses the official SDK's *pure* quote function
 * (`swapQuoteWithParams`) fed from our batched account snapshot, so quoting
 * never hits the network — the same pattern as Jupiter's Amm trait.
 */
export class OrcaWhirlpoolAmm implements Amm {
  readonly label = "Orca Whirlpool";
  readonly programId = ORCA_WHIRLPOOL_PROGRAM_ID;
  private pool: WhirlpoolData;
  private tickArrays: { aToB: TickArray[]; bToA: TickArray[] } = { aToB: [], bToA: [] };
  private oracle: OracleData | null = null;
  private mintA?: MintInfo;
  private mintB?: MintInfo;
  private clock?: { epoch: number; unixTimestamp: number };
  private readonly oracleKey: PublicKey;

  constructor(
    readonly key: PublicKey,
    poolAccount: AccountInfo<Buffer>,
    private readonly program: Program<any>,
  ) {
    const parsed = ParsableWhirlpool.parse(key, poolAccount);
    if (!parsed) throw new Error(`not a Whirlpool: ${key.toBase58()}`);
    this.pool = parsed;
    this.oracleKey = PDAUtil.getOracle(this.programId, key).publicKey;
  }

  reserveMints() {
    return [this.pool.tokenMintA, this.pool.tokenMintB];
  }

  private tickArrayKeys(aToB: boolean): { address: PublicKey; startTickIndex: number }[] {
    const { tickCurrentIndex, tickSpacing } = this.pool;
    const shift = aToB ? 0 : tickSpacing; // mirrors SwapUtils.getTickArrayPublicKeys
    const out: { address: PublicKey; startTickIndex: number }[] = [];
    for (let i = 0; i < TICK_ARRAYS_PER_SIDE; i++) {
      const offset = aToB ? -i : i;
      let start: number;
      try {
        start = TickUtil.getStartTickIndex(tickCurrentIndex + shift, tickSpacing, offset);
      } catch {
        break; // out of tick range
      }
      out.push({ address: PDAUtil.getTickArray(this.programId, this.key, start).publicKey, startTickIndex: start });
    }
    return out;
  }

  /** Dynamic: tick array set moves with the price, like Jupiter's `has_dynamic_accounts`. */
  accountsToUpdate() {
    const tas = [...this.tickArrayKeys(true), ...this.tickArrayKeys(false)].map((t) => t.address);
    return [this.key, this.oracleKey, this.pool.tokenMintA, this.pool.tokenMintB, SYSVAR_CLOCK_PUBKEY, ...tas];
  }

  update(accounts: AccountMap) {
    const get = (k: PublicKey) => accounts.get(k.toBase58());
    const poolAcc = get(this.key);
    if (poolAcc) this.pool = ParsableWhirlpool.parse(this.key, poolAcc) ?? this.pool;

    const load = (keys: { address: PublicKey; startTickIndex: number }[]): TickArray[] =>
      keys.map(({ address, startTickIndex }) => ({ address, startTickIndex, data: ParsableTickArray.parse(address, get(address)) }));
    this.tickArrays = { aToB: load(this.tickArrayKeys(true)), bToA: load(this.tickArrayKeys(false)) };

    this.oracle = ParsableOracle.parse(this.oracleKey, get(this.oracleKey));

    for (const side of ["A", "B"] as const) {
      const mint = side === "A" ? this.pool.tokenMintA : this.pool.tokenMintB;
      const acc = get(mint);
      if (acc) {
        const info = { ...unpackMint(mint, acc, acc.owner), tokenProgram: acc.owner };
        if (side === "A") this.mintA = info;
        else this.mintB = info;
      }
    }
    const clock = get(SYSVAR_CLOCK_PUBKEY);
    if (clock) {
      this.clock = { epoch: Number(clock.data.readBigUInt64LE(16)), unixTimestamp: Number(clock.data.readBigInt64LE(32)) };
    }
  }

  isActive() {
    return !!this.mintA && !!this.mintB && !!this.clock && this.pool.liquidity.gtn(0);
  }

  private run(inputMint: PublicKey, amount: bigint, minOut?: bigint) {
    if (!this.mintA || !this.mintB || !this.clock) throw new Error("Whirlpool not loaded");
    const aToB = inputMint.equals(this.pool.tokenMintA);
    if (!aToB && !inputMint.equals(this.pool.tokenMintB)) throw new Error("mint not in pool");
    const q = swapQuoteWithParams(
      {
        whirlpoolData: this.pool,
        tokenAmount: new BN(amount.toString()),
        otherAmountThreshold: minOut !== undefined ? new BN(minOut.toString()) : SwapUtils.getDefaultOtherAmountThreshold(true),
        sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToB),
        aToB,
        amountSpecifiedIsInput: true,
        tickArrays: aToB ? this.tickArrays.aToB : this.tickArrays.bToA,
        oracleData: this.oracle,
        tokenExtensionCtx: {
          currentEpoch: this.clock.epoch,
          tokenMintWithProgramA: this.mintA,
          tokenMintWithProgramB: this.mintB,
        },
        timestampInSeconds: new BN(this.clock.unixTimestamp),
      },
      NO_SLIPPAGE,
    );
    return { q, aToB };
  }

  quote({ inputMint, amount }: QuoteParams): Quote {
    try {
      const { q } = this.run(inputMint, amount);
      return {
        inAmount: BigInt(q.estimatedAmountIn.toString()),
        outAmount: BigInt(q.estimatedAmountOut.toString()),
        feeAmount: BigInt(q.estimatedFeeAmount.toString()),
        feeMint: inputMint,
      };
    } catch {
      // Out of initialized tick arrays / liquidity for this size.
      return { inAmount: amount, outAmount: 0n, feeAmount: 0n, feeMint: inputMint, notEnoughLiquidity: true };
    }
  }

  swapInstructions(p: SwapParams): TransactionInstruction[] {
    const { q, aToB } = this.run(p.inputMint, p.inAmount, p.minOutAmount);
    const ix = WhirlpoolIx.swapV2Ix(this.program, {
      amount: q.amount,
      otherAmountThreshold: new BN(p.minOutAmount.toString()),
      sqrtPriceLimit: q.sqrtPriceLimit,
      amountSpecifiedIsInput: true,
      aToB,
      tickArray0: q.tickArray0,
      tickArray1: q.tickArray1,
      tickArray2: q.tickArray2,
      supplementalTickArrays: q.supplementalTickArrays,
      whirlpool: this.key,
      tokenMintA: this.pool.tokenMintA,
      tokenMintB: this.pool.tokenMintB,
      tokenOwnerAccountA: aToB ? p.userSourceTokenAccount : p.userDestinationTokenAccount,
      tokenOwnerAccountB: aToB ? p.userDestinationTokenAccount : p.userSourceTokenAccount,
      tokenVaultA: this.pool.tokenVaultA,
      tokenVaultB: this.pool.tokenVaultB,
      tokenProgramA: this.mintA!.tokenProgram,
      tokenProgramB: this.mintB!.tokenProgram,
      oracle: this.oracleKey,
      tokenAuthority: p.user,
    });
    return ix.instructions;
  }
}
