import { createRequire } from "node:module";
import BN from "bn.js";
import type DLMMClass from "@meteora-ag/dlmm";
import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import type { AccountMap, Amm, Quote, QuoteParams, SwapParams } from "../types.js";

// The SDK's ESM build imports `BN` as a named export from Anchor's CJS bundle, which Node's ESM
// loader rejects. Loading the CJS build sidesteps it.
const dlmmModule = createRequire(import.meta.url)("@meteora-ag/dlmm");
// The CJS build exports the class as module.exports itself (with named exports attached).
const DLMM: typeof DLMMClass = dlmmModule.default ?? dlmmModule;

export const METEORA_DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
type DlmmInstance = Awaited<ReturnType<typeof DLMM.create>>;
type BinArrays = Awaited<ReturnType<DlmmInstance["getBinArrayForSwap"]>>;

/**
 * Meteora DLMM via the official SDK.
 *
 * The SDK owns its own fetching, so this adapter uses `refresh()` (network) to
 * pre-load state + bin arrays, and keeps `quote()` pure against that cache.
 * TODO(phase 3): decode LbPair/BinArray from the batched AccountMap like the
 * other adapters so DLMM rides the same gRPC stream.
 */
export class MeteoraDlmmAmm implements Amm {
  readonly label = "Meteora DLMM";
  readonly programId = METEORA_DLMM_PROGRAM_ID;
  readonly amountInOffset = 8; // [disc][amount_in u64]...
  private binArrays: { xToY: BinArrays; yToX: BinArrays } = { xToY: [], yToX: [] };
  private loaded = false;

  private constructor(readonly key: PublicKey, private readonly dlmm: DlmmInstance) {}

  static async load(connection: Connection, key: PublicKey) {
    const amm = new MeteoraDlmmAmm(key, await DLMM.create(connection, key));
    await amm.refresh();
    return amm;
  }

  reserveMints() {
    return [this.dlmm.tokenX.publicKey, this.dlmm.tokenY.publicKey];
  }

  accountsToUpdate() {
    return []; // handled by refresh()
  }

  update(_accounts: AccountMap) {}

  async refresh() {
    await this.dlmm.refetchStates();
    const [xToY, yToX] = await Promise.all([this.dlmm.getBinArrayForSwap(true), this.dlmm.getBinArrayForSwap(false)]);
    this.binArrays = { xToY, yToX };
    this.loaded = true;
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
