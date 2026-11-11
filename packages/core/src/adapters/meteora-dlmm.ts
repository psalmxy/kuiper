import { createRequire } from "node:module";
import BN from "bn.js";
import type DLMMClass from "@meteora-ag/dlmm";
import { AccountLayout } from "@solana/spl-token";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection, type TransactionInstruction } from "@solana/web3.js";
import type { AccountMap, Amm, Quote, QuoteParams, SwapParams } from "../types.js";

// The SDK's ESM build imports `BN` as a named export from Anchor's CJS bundle, which Node's ESM
// loader rejects. Loading the CJS build sidesteps it. The CJS build exports the class as
// module.exports itself (with named exports attached).
const sdk = createRequire(import.meta.url)("@meteora-ag/dlmm");
const DLMM: typeof DLMMClass = sdk.default ?? sdk;
const { decodeAccount, deriveBinArray, deriveBinArrayBitmapExtension, findNextBinArrayIndexWithLiquidity, getBinArrayLowerUpperBinId, ClockLayout } = sdk;

export const METEORA_DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
type DlmmInstance = Awaited<ReturnType<typeof DLMM.create>>;
type BinArrays = Awaited<ReturnType<DlmmInstance["getBinArrayForSwap"]>>;

/** Bin arrays loaded per direction (each holds 70 bins). */
const BIN_ARRAYS_PER_SIDE = 4;

/**
 * Meteora DLMM.
 *
 * The SDK is used once at startup (`DLMM.create`) for static data (mints, token programs,
 * transfer hooks). After that the adapter rides the shared batched account fetch like the others:
 * it lists the LbPair, reserves, bitmap extension, clock and the bin arrays around the active bin,
 * decodes them with the SDK's own Anchor coder, and quotes with the SDK's pure `swapQuote`.
 * No per-pool RPC calls during refresh — that's what lets 2s refresh fit a free RPC plan.
 */
export class MeteoraDlmmAmm implements Amm {
  readonly label = "Meteora DLMM";
  readonly programId = METEORA_DLMM_PROGRAM_ID;
  readonly amountInOffset = 8; // [disc][amount_in u64]...
  private binArrays: { xToY: BinArrays; yToX: BinArrays } = { xToY: [], yToX: [] };
  private loaded = false;
  private readonly bitmapExt: PublicKey;

  private constructor(readonly key: PublicKey, private readonly dlmm: DlmmInstance) {
    this.bitmapExt = deriveBinArrayBitmapExtension(key, METEORA_DLMM_PROGRAM_ID)[0];
  }

  static async load(connection: Connection, key: PublicKey) {
    return new MeteoraDlmmAmm(key, await DLMM.create(connection, key));
  }

  reserveMints() {
    return [this.dlmm.tokenX.publicKey, this.dlmm.tokenY.publicKey];
  }

  /** Mirrors the SDK's getBinArrayForSwap walk, without fetching. */
  private binArrayKeys(swapForY: boolean): PublicKey[] {
    const keys: PublicKey[] = [];
    let active = this.dlmm.lbPair.activeId;
    while (keys.length < BIN_ARRAYS_PER_SIDE) {
      const idx = findNextBinArrayIndexWithLiquidity(swapForY, new BN(active), this.dlmm.lbPair, this.dlmm.binArrayBitmapExtension?.account ?? null);
      if (idx === null) break;
      keys.push(deriveBinArray(this.key, idx, METEORA_DLMM_PROGRAM_ID)[0]);
      const [lower, upper] = getBinArrayLowerUpperBinId(idx);
      active = swapForY ? lower.toNumber() - 1 : upper.toNumber() + 1;
    }
    return keys;
  }

  /** Dynamic: the bin-array window follows the active bin. */
  accountsToUpdate() {
    return [
      this.key,
      this.bitmapExt,
      this.dlmm.lbPair.reserveX,
      this.dlmm.lbPair.reserveY,
      SYSVAR_CLOCK_PUBKEY,
      ...this.binArrayKeys(true),
      ...this.binArrayKeys(false),
    ];
  }

  update(accounts: AccountMap) {
    const get = (k: PublicKey) => accounts.get(k.toBase58());
    const pool = get(this.key);
    if (!pool) return;
    const d = this.dlmm as any;
    d.lbPair = decodeAccount(d.program, "lbPair", pool.data);
    const ext = get(this.bitmapExt);
    d.binArrayBitmapExtension = ext ? { publicKey: this.bitmapExt, account: decodeAccount(d.program, "binArrayBitmapExtension", ext.data) } : null;
    const rx = get(d.lbPair.reserveX);
    const ry = get(d.lbPair.reserveY);
    if (rx) d.tokenX.amount = AccountLayout.decode(rx.data).amount;
    if (ry) d.tokenY.amount = AccountLayout.decode(ry.data).amount;
    const clock = get(SYSVAR_CLOCK_PUBKEY);
    if (clock) d.clock = ClockLayout.decode(clock.data);

    const load = (keys: PublicKey[]): BinArrays =>
      keys.flatMap((k) => {
        const acc = get(k);
        return acc ? [{ publicKey: k, account: decodeAccount(d.program, "binArray", acc.data) }] : [];
      });
    // Keys come from the freshly decoded active bin; arrays missing from this batch arrive next refresh.
    this.binArrays = { xToY: load(this.binArrayKeys(true)), yToX: load(this.binArrayKeys(false)) };
    this.loaded = this.binArrays.xToY.length + this.binArrays.yToX.length > 0;
  }

  isActive() {
    return this.loaded;
  }

  private swapForY(inputMint: PublicKey) {
    if (inputMint.equals(this.dlmm.tokenX.publicKey)) return true;
    if (inputMint.equals(this.dlmm.tokenY.publicKey)) return false;
    throw new Error("mint not in pool");
  }

  quote({ inputMint, amount }: QuoteParams): Quote {
    const swapForY = this.swapForY(inputMint);
    try {
      const q = this.dlmm.swapQuote(new BN(amount.toString()), swapForY, new BN(0), swapForY ? this.binArrays.xToY : this.binArrays.yToX);
      const consumed = BigInt(q.consumedInAmount.toString());
      return {
        inAmount: amount,
        outAmount: BigInt(q.outAmount.toString()),
        feeAmount: BigInt(q.fee.toString()),
        feeMint: inputMint,
        notEnoughLiquidity: consumed < amount,
      };
    } catch {
      return { inAmount: amount, outAmount: 0n, feeAmount: 0n, feeMint: inputMint, notEnoughLiquidity: true };
    }
  }

  async swapInstructions(p: SwapParams): Promise<TransactionInstruction[]> {
    const swapForY = this.swapForY(p.inputMint);
    const binArrays = swapForY ? this.binArrays.xToY : this.binArrays.yToX;
    const q = this.dlmm.swapQuote(new BN(p.inAmount.toString()), swapForY, new BN(0), binArrays);
    const tx = await this.dlmm.swap({
      inToken: p.inputMint,
      outToken: p.outputMint,
      inAmount: new BN(p.inAmount.toString()),
      minOutAmount: new BN(p.minOutAmount.toString()),
      lbPair: this.key,
      user: p.user,
      binArraysPubkey: q.binArraysPubkey,
    });
    // The SDK adds its own ATA/wSOL/compute-budget setup; our tx builder owns those, so keep only the swap.
    return tx.instructions.filter((ix) => ix.programId.equals(this.programId));
  }
}
