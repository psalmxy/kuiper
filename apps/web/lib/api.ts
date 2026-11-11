const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export interface Leg {
  label: string;
  pool: string;
  percent: number;
  inAmount?: string;
  outAmount?: string;
}

export interface RouteSummary {
  inAmount: string;
  outAmount: string;
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
