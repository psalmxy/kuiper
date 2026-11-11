import { AddressLookupTableAccount, PublicKey, TransactionInstruction } from "@solana/web3.js";

const BASE = "https://api.jup.ag/swap/v2";

interface JupIx {
  programId: string;
  accounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[];
  data: string; // base64
}

export interface JupBuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  routePlan: { percent: number; swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string } }[];
  computeBudgetInstructions: JupIx[];
  setupInstructions: JupIx[];
  swapInstruction: JupIx;
  cleanupInstruction: JupIx | null;
  otherInstructions: JupIx[];
  addressesByLookupTableAddress: Record<string, string[]>;
}

const toIx = (ix: JupIx) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isWritable: a.isWritable, isSigner: a.isSigner })),
    data: Buffer.from(ix.data, "base64"),
  });

/**
 * Jupiter fallback via the Router path (`/swap/v2/build`, Metis only).
 * We use /build rather than /order because it returns raw instructions we can
 * compose with our own fee instruction — and Jupiter charges no swap fee on /build.
 */
export class JupiterClient {
  constructor(private readonly apiKey: string) {}

  get enabled() {
    return this.apiKey.length > 0;
  }

  async build(p: { inputMint: string; outputMint: string; amount: bigint; taker: string; slippageBps: number; maxAccounts?: number }) {
    if (!this.enabled) return null;
    const qs = new URLSearchParams({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amount.toString(),
      taker: p.taker,
      slippageBps: String(p.slippageBps),
      // leave room in the tx for our fee + compute-budget instructions
      maxAccounts: String(p.maxAccounts ?? 54),
    });
    const res = await fetch(`${BASE}/build?${qs}`, { headers: { "x-api-key": this.apiKey }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`jupiter /build ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as JupBuildResponse;
  }

  /** Swap-path instructions only; compute budget is set by our own builder. */
  static instructions(r: JupBuildResponse): TransactionInstruction[] {
    return [...r.setupInstructions.map(toIx), toIx(r.swapInstruction), ...(r.cleanupInstruction ? [toIx(r.cleanupInstruction)] : []), ...r.otherInstructions.map(toIx)];
  }

  static lookupTables(r: JupBuildResponse): AddressLookupTableAccount[] {
    return Object.entries(r.addressesByLookupTableAddress ?? {}).map(
      ([key, addrs]) =>
        new AddressLookupTableAccount({
          key: new PublicKey(key),
          state: {
            deactivationSlot: BigInt("18446744073709551615"),
            lastExtendedSlot: 0,
            lastExtendedSlotStartIndex: 0,
            addresses: addrs.map((a) => new PublicKey(a)),
          },
        }),
    );
  }
}
