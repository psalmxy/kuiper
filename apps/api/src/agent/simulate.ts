import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import type { Simulation } from "./tickets.js";

export interface WatchMint {
  mint: string;
  symbol: string;
  decimals: number;
  tokenProgram: PublicKey;
}

const fmt = (raw: bigint, decimals: number) => {
  const neg = raw < 0n;
  const a = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
  return `${neg ? "-" : "+"}${(a / base).toString()}${frac ? "." + frac : ""}`;
};

const BASE_FEE = 5_000n; // lamports per signature, paid by the baseline tx

/**
 * Simulate exactly the transaction the user will sign and report what it does to *their*
 * balances (SOL incl. network fee, plus each token involved). This is the "what happens if I
 * approve" section of a ticket.
 *
 * Balances are diffed against a *baseline simulation* (a no-op tx from the same wallet, run at
 * the same time) rather than a separate earlier read, so unrelated activity on the wallet between
 * reads can't leak into the numbers.
 */
export async function simulateWithBalanceChanges(connection: Connection, tx: VersionedTransaction, user: PublicKey, watch: WatchMint[]): Promise<Simulation> {
  const tokenWatch = watch.filter((w) => !new PublicKey(w.mint).equals(NATIVE_MINT));
  // Always watch the wSOL account too: swaps wrap/unwrap through it, and closing it unwraps any wSOL
  // the user already held. Native SOL + wSOL are reported together as one SOL figure.
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, true);
  const addrs = [user, wsolAta, ...tokenWatch.map((w) => getAssociatedTokenAddressSync(new PublicKey(w.mint), user, true, w.tokenProgram))];
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const baselineTx = new VersionedTransaction(
    new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 })] }).compileToV0Message(),
  );
  // Some RPCs (the public one) cap watched accounts per simulation at 2, so watch them in chunks.
  const chunk = Number(process.env.SIM_ACCOUNTS_PER_CALL ?? 2);
  const groups: string[][] = [];
  for (let i = 0; i < addrs.length; i += chunk) groups.push(addrs.slice(i, i + chunk).map((a) => a.toBase58()));
  const opts = (addresses: string[]) => ({ sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" as const, accounts: { encoding: "base64" as const, addresses } });
  const pairs = await Promise.all(
    groups.map((g) => Promise.all([connection.simulateTransaction(tx, opts(g)), connection.simulateTransaction(baselineTx, opts(g))])),
  );
  const v = { ...pairs[0]![0].value, accounts: pairs.flatMap(([s]) => s.value.accounts ?? []) };
  const base = { value: { err: pairs[0]![1].value.err, accounts: pairs.flatMap(([, b]) => b.value.accounts ?? []) } };
  if (!v.err) for (const [s] of pairs) if (s.value.err) v.err = s.value.err;
  if (v.err) {
    return { ok: false, error: JSON.stringify(v.err), computeUnits: v.unitsConsumed, balanceChanges: [], logsTail: (v.logs ?? []).slice(-8) };
  }

  const tokenAmount = (a: { data: string[] } | null | undefined) => (a?.data?.[0] ? Buffer.from(a.data[0], "base64").readBigUInt64LE(64) : 0n);
  const changes: Simulation["balanceChanges"] = [];
  // SOL = lamports + wSOL tokens. When the wSOL account is closed, its rent comes back as lamports too,
  // so count the wSOL account's lamports rather than its token amount.
  const solTotal = (accs: typeof v.accounts) => BigInt(accs?.[0]?.lamports ?? 0) + BigInt(accs?.[1]?.lamports ?? 0);
  const solPost = solTotal(v.accounts);
  const solPre = solTotal(base.value.accounts) + (base.value.err ? 0n : BASE_FEE);
  if (solPost !== solPre) changes.push({ mint: NATIVE_MINT.toBase58(), symbol: "SOL (incl. fees)", delta: fmt(solPost - solPre, 9) });

  tokenWatch.forEach((w, i) => {
    const preAmt = tokenAmount(base.value.accounts?.[i + 2] as any);
    const postAmt = tokenAmount(v.accounts?.[i + 2] as any);
    if (postAmt !== preAmt) changes.push({ mint: w.mint, symbol: w.symbol, delta: fmt(postAmt - preAmt, w.decimals) });
  });

  return { ok: true, computeUnits: v.unitsConsumed, balanceChanges: changes };
}
