const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export interface Leg {
  hop: number;
  label: string;
  pool: string;
  percent: number;
  inAmount?: string;
  outAmount?: string;
}

export interface RouteSummary {
  inAmount: string;
  outAmount: string;
  /** Mints along the route, e.g. [SOL, USDC, BONK] for a 2-hop route. */
  path: string[];
  legs: Leg[];
}

export interface QuoteResponse {
  inAmount: string;
  platformFee: string;
  netAmount: string;
  best: "kuiper" | "jupiter" | null;
  kuiper: RouteSummary | null;
  jupiter: RouteSummary | null;
  jupiterError?: string;
}

export interface SwapResponse {
  source: "kuiper" | "jupiter";
  transaction: string;
  lastValidBlockHeight: number;
  outAmount: string;
  minOutAmount: string;
  feeAmount: string;
  computeUnits: number;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const getQuote = (p: { inputMint: string; outputMint: string; amount: string; slippageBps: number; taker?: string }, signal?: AbortSignal) =>
{
  const qs = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount, slippageBps: String(p.slippageBps) });
  if (p.taker) qs.set("taker", p.taker);
  return call<QuoteResponse>(`/quote?${qs}`, { signal });
};

export const buildSwap = (p: { inputMint: string; outputMint: string; amount: string; slippageBps: number; taker: string }) =>
  call<SwapResponse>("/swap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });

export const sendSigned = (signedTransaction: string) =>
  call<{ signature: string }>("/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signedTransaction }) });

// ---------------- DeFi agent ----------------
export type Risk = "low" | "medium" | "high";
export interface Ticket {
  id: string;
  kind: "swap" | "stake" | "lend" | "borrow" | "recurring";
  title: string;
  summary: string;
  details: { label: string; value: string }[];
  tokenChecks: { mint: string; symbol: string; risk: Risk; flags: { level: Risk; text: string }[] }[];
  simulation: { ok: boolean; error?: string; computeUnits?: number; balanceChanges: { mint: string; symbol: string; delta: string }[]; logsTail?: string[] };
  warnings: string[];
  transaction: string;
  user: string;
  createdAt: number;
  expiresAt: number;
  status: "ready" | "submitted" | "confirmed" | "failed" | "expired";
  signature?: string;
}

export const agentChat = (p: { sessionId?: string; message: string; wallet?: string }) =>
  call<{ sessionId: string; reply: string; tickets: Ticket[] }>("/agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p),
  });

export const refreshTicket = (id: string) => call<Ticket>(`/agent/tickets/${id}/refresh`, { method: "POST" });

export const submitTicket = (id: string, signedTransaction: string) =>
  call<{ signature: string; ticket: Ticket }>(`/agent/tickets/${id}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedTransaction }),
  });
