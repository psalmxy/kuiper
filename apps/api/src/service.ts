import {
  PoolCache,
  Router,
  buildKuiperSwapInstructions,
  platformFeeInstructions,
  type PlatformFee,
  type Route,
} from "@kuiper/core";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import { JupiterClient, type JupBuildResponse } from "./jupiter.js";

const QUOTE_TAKER = new PublicKey("KuiperQuoteTaker111111111111111111111111111"); // placeholder taker for wallet-less quotes
const MAX_CU = 1_400_000;

export type Source = "kuiper" | "jupiter";

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  taker?: string;
}

export interface QuoteResult {
  inAmount: bigint;
  feeAmount: bigint;
  netAmount: bigint;
  best: Source | null;
  kuiper: Route | null;
  jupiter: JupBuildResponse | null;
  jupiterError?: string;
}

export class SwapService {
  private mints = new Map<string, { tokenProgram: PublicKey; decimals: number }>();
  private feeAccounts = new Map<string, { exists: boolean; at: number }>();

  constructor(
    private readonly connection: Connection,
    readonly cache: PoolCache,
    readonly router: Router,
    private readonly jupiter: JupiterClient,
    private readonly cfg: { feeWallet?: PublicKey; feeBps: number },
  ) {}

  async mintInfo(mint: PublicKey) {
    const k = mint.toBase58();
    let m = this.mints.get(k);
    if (!m) {
      const acc = await this.connection.getAccountInfo(mint);
      if (!acc) throw new Error(`mint not found: ${k}`);
      m = { tokenProgram: acc.owner, decimals: acc.data.readUInt8(44) };
      this.mints.set(k, m);
    }
    return m;
  }

  /** Fee in input token. SPL fees need the fee wallet's token account to already exist (see scripts/create-fee-accounts.ts). */
  private async platformFee(inputMint: PublicKey, amount: bigint): Promise<PlatformFee | undefined> {
    const wallet = this.cfg.feeWallet;
    if (!wallet || this.cfg.feeBps === 0) return undefined;
    const fee = (amount * BigInt(this.cfg.feeBps)) / 10_000n;
    if (fee === 0n) return undefined;
    const { tokenProgram, decimals } = await this.mintInfo(inputMint);
    if (inputMint.equals(NATIVE_MINT)) return { amount: fee, destination: wallet, inputDecimals: decimals };

    const ata = getAssociatedTokenAddressSync(inputMint, wallet, true, tokenProgram);
    const cached = this.feeAccounts.get(ata.toBase58());
    let exists = cached && Date.now() - cached.at < 300_000 ? cached.exists : undefined;
    if (exists === undefined) {
      exists = (await this.connection.getAccountInfo(ata)) !== null;
      this.feeAccounts.set(ata.toBase58(), { exists, at: Date.now() });
    }
    return exists ? { amount: fee, destination: ata, inputDecimals: decimals } : undefined;
  }

  async quote(req: QuoteRequest): Promise<QuoteResult & { fee?: PlatformFee }> {
    const inputMint = new PublicKey(req.inputMint);
    const outputMint = new PublicKey(req.outputMint);
    const fee = await this.platformFee(inputMint, req.amount);
    const netAmount = req.amount - (fee?.amount ?? 0n);

    const kuiper = this.router.bestRoute(inputMint, outputMint, netAmount);
    let jupiter: JupBuildResponse | null = null;
    let jupiterError: string | undefined;
    try {
      jupiter = await this.jupiter.build({
        inputMint: req.inputMint,
        outputMint: req.outputMint,
        amount: netAmount,
        taker: req.taker ?? QUOTE_TAKER.toBase58(),
        slippageBps: req.slippageBps,
      });
    } catch (e) {
      jupiterError = (e as Error).message;
    }

    const kOut = kuiper?.outAmount ?? -1n;
    const jOut = jupiter ? BigInt(jupiter.outAmount) : -1n;
    const best: Source | null = kOut < 0n && jOut < 0n ? null : kOut >= jOut ? "kuiper" : "jupiter";
    return { inAmount: req.amount, feeAmount: fee?.amount ?? 0n, netAmount, best, kuiper, jupiter, jupiterError, fee };
  }

  async buildSwap(req: QuoteRequest & { taker: string; source?: Source }) {
    const user = new PublicKey(req.taker);
    const q = await this.quote(req);
    const source = req.source ?? q.best;
    if (!source) throw new Error("no route found");
    const inputMint = new PublicKey(req.inputMint);
    const outputMint = new PublicKey(req.outputMint);
    const [inInfo, outInfo] = await Promise.all([this.mintInfo(inputMint), this.mintInfo(outputMint)]);
    const priority = await this.priorityFee();

    let ixs: TransactionInstruction[];
    let alts: AddressLookupTableAccount[] = [];
    let outAmount: bigint;
    let minOutAmount: bigint;

    if (source === "kuiper") {
      if (!q.kuiper) throw new Error("no Kuiper route for this pair/size");
      ixs = await buildKuiperSwapInstructions({
        route: q.kuiper,
        user,
        slippageBps: req.slippageBps,
        inputTokenProgram: inInfo.tokenProgram,
        outputTokenProgram: outInfo.tokenProgram,
        priorityMicroLamports: priority,
        platformFee: q.fee,
      });
      outAmount = q.kuiper.outAmount;
      minOutAmount = (outAmount * BigInt(10_000 - req.slippageBps)) / 10_000n;
    } else {
      if (!q.jupiter) throw new Error(`no Jupiter route: ${q.jupiterError ?? "disabled"}`);
      ixs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
        ...platformFeeInstructions({ user, inputMint, inputTokenProgram: inInfo.tokenProgram, fee: q.fee }),
        ...JupiterClient.instructions(q.jupiter),
      ];
      alts = JupiterClient.lookupTables(q.jupiter);
      outAmount = BigInt(q.jupiter.outAmount);
      minOutAmount = BigInt(q.jupiter.otherAmountThreshold);
    }

    // Simulate, then right-size the compute limit (1.2x used) — same recipe Jupiter documents for /build.
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const compile = () =>
      new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts));
    const sim = await this.connection.simulateTransaction(compile(), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).slice(-6).join("\n");
      throw Object.assign(new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`), { logs });
    }
    const used = sim.value.unitsConsumed ?? MAX_CU;
    ixs[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(MAX_CU, Math.ceil(used * 1.2)) });
    const tx = compile();

    return {
      source,
      transaction: Buffer.from(tx.serialize()).toString("base64"),
      lastValidBlockHeight,
      inAmount: req.amount,
      feeAmount: q.feeAmount,
      outAmount,
      minOutAmount,
      computeUnits: used,
    };
  }

  private priorityCache = { value: 10_000, at: 0 };
  /** 75th percentile of recent priority fees, clamped. */
  async priorityFee(): Promise<number> {
    if (Date.now() - this.priorityCache.at < 10_000) return this.priorityCache.value;
    try {
      const fees = (await this.connection.getRecentPrioritizationFees()).map((f) => f.prioritizationFee).sort((a, b) => a - b);
      const p75 = fees[Math.floor(fees.length * 0.75)] ?? 10_000;
      this.priorityCache = { value: Math.min(Math.max(p75, 5_000), 2_000_000), at: Date.now() };
    } catch {
      /* keep last value */
    }
    return this.priorityCache.value;
  }
}
