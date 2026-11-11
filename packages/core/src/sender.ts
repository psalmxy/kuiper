import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

/**
 * Helius Sender — fast transaction landing (staked connections + Jito in parallel).
 * Every Sender transaction must carry a SOL tip to one of these accounts and be sent with
 * skipPreflight. The tip goes into the transaction *before* the user signs, so it shows on the
 * ticket and in the simulated balance changes.
 *
 * Tiers: SWQOS-only (`?swqos_only=true`) has a 0.000005 SOL minimum tip; dual routing needs more.
 */
export const SENDER_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
].map((a) => new PublicKey(a));

const TIP_SET = new Set(SENDER_TIP_ACCOUNTS.map((a) => a.toBase58()));

export function senderTipInstruction(user: PublicKey, lamports: number): TransactionInstruction {
  const to = SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length)]!;
  return SystemProgram.transfer({ fromPubkey: user, toPubkey: to, lamports });
}

export function hasSenderTip(ixs: TransactionInstruction[]): boolean {
  return ixs.some((ix) => ix.programId.equals(SystemProgram.programId) && ix.keys.some((k) => TIP_SET.has(k.pubkey.toBase58())));
}

/** POST a signed transaction to Sender. Throws with Sender's message on rejection. */
export async function sendViaSender(url: string, signedTxBase64: string): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now().toString(),
      method: "sendTransaction",
      params: [signedTxBase64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  // Success is JSON-RPC ({ result }); rejections come back either as { error: {...} } or bare { code, message }.
  const json = (await res.json()) as { result?: string; error?: { message: string }; message?: string };
  if (!json.result) throw new Error(`sender: ${json.error?.message ?? json.message ?? res.status}`);
  return json.result;
}
