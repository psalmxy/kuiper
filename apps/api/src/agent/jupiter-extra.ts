/**
 * Jupiter APIs the agent uses for products Kuiper doesn't run itself (yet):
 * token search + Shield warnings, Lend (Earn + Borrow), and Recurring (time-based DCA).
 * All return *unsigned* transactions for the user's wallet.
 */
const BASE = "https://api.jup.ag";

export interface ShieldWarning {
  type: string;
  message?: string;
  severity?: string;
}

export interface TokenSearchResult {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  isVerified?: boolean;
  organicScore?: number;
  usdPrice?: number;
  liquidity?: number;
}

export class JupiterExtra {
  constructor(private readonly apiKey: string) {}

  get enabled() {
    return this.apiKey.length > 0;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.enabled) throw new Error("JUP_API_KEY not set");
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "x-api-key": this.apiKey, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`jupiter ${path} ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  async searchTokens(query: string): Promise<TokenSearchResult[]> {
    return (await this.call<TokenSearchResult[]>(`/ultra/v1/search?query=${encodeURIComponent(query)}`)).slice(0, 8);
  }

  async shield(mint: string): Promise<ShieldWarning[]> {
    const r = await this.call<{ warnings: Record<string, ShieldWarning[]> }>(`/ultra/v1/shield?mints=${mint}`);
    return r.warnings?.[mint] ?? [];
  }

  /** Jupiter Earn: deposit `asset` to earn lending yield. */
  async lendDeposit(p: { asset: string; amount: bigint; signer: string }) {
    return this.call<{ transaction: string }>("/lend/v1/earn/deposit", {
      method: "POST",
      body: JSON.stringify({ asset: p.asset, amount: p.amount.toString(), signer: p.signer }),
    });
  }

  async lendTokens() {
    return this.call<{ asset: { address: string; symbol: string }; supplyRate?: number | string; totalRate?: number | string }[]>("/lend/v1/earn/tokens");
  }

  async borrowVaults() {
    return this.call<
      { id: number; supplyToken: { address: string; symbol?: string }; borrowToken: { address: string; symbol?: string }; collateralFactor?: number; liquidationThreshold?: number; borrowRate?: number | string }[]
    >("/lend/v1/borrow/vaults");
  }

  /** Jupiter Borrow: positive colAmount deposits collateral, positive debtAmount borrows. positionId 0 opens a new position. */
  async borrowOperate(p: { vaultId: number; colAmount: bigint; debtAmount: bigint; signer: string }) {
    return this.call<{ transaction: string; nftId?: number }>("/lend/v1/borrow/operate", {
      method: "POST",
      body: JSON.stringify({ vaultId: p.vaultId, positionId: 0, colAmount: p.colAmount.toString(), debtAmount: p.debtAmount.toString(), signer: p.signer }),
    });
  }

  /** Recurring (time-based DCA): spend `inAmount` over `numberOfOrders` buys, `interval` seconds apart. */
  async recurringCreate(p: { user: string; inputMint: string; outputMint: string; inAmount: bigint; numberOfOrders: number; interval: number }) {
    return this.call<{ requestId: string; transaction: string }>("/recurring/v1/createOrder", {
      method: "POST",
      body: JSON.stringify({
        user: p.user,
        inputMint: p.inputMint,
        outputMint: p.outputMint,
        params: { time: { inAmount: Number(p.inAmount), numberOfOrders: p.numberOfOrders, interval: p.interval, minPrice: null, maxPrice: null, startAt: null } },
      }),
    });
  }

  async recurringExecute(requestId: string, signedTransaction: string) {
    return this.call<{ signature?: string; status: string; error?: string }>("/recurring/v1/execute", {
      method: "POST",
      body: JSON.stringify({ requestId, signedTransaction }),
    });
  }
}
