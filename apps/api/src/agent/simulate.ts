import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
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

/**
 * Simulate exactly the transaction the user will sign and report what it does to *their*
 * balances (SOL incl. network fee, plus each token involved). This is the "what happens if I
 * approve" section of a ticket.
 */
export async function simulateWithBalanceChanges(connection: Connection, tx: VersionedTransaction, user: PublicKey, watch: WatchMint[]): Promise<Simulation> {
  const tokenWatch = watch.filter((w) => !new PublicKey(w.mint).equals(NATIVE_MINT));
  const addrs = [user, ...tokenWatch.map((w) => getAssociatedTokenAddressSync(new PublicKey(w.mint), user, true, w.tokenProgram))];
  const before = await connection.getMultipleAccountsInfo(addrs, "confirmed");

  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: addrs.map((a) => a.toBase58()) },
  });
  const v = sim.value;
  if (v.err) {
    return { ok: false, error: JSON.stringify(v.err), computeUnits: v.unitsConsumed, balanceChanges: [], logsTail: (v.logs ?? []).slice(-8) };
  }

  const changes: Simulation["balanceChanges"] = [];
  const solPost = BigInt(v.accounts?.[0]?.lamports ?? 0);
  const solPre = BigInt(before[0]?.lamports ?? 0);
  if (solPost !== solPre) changes.push({ mint: NATIVE_MINT.toBase58(), symbol: "SOL (incl. fees)", delta: fmt(solPost - solPre, 9) });

  tokenWatch.forEach((w, i) => {
    const pre = before[i + 1];
    const post = v.accounts?.[i + 1];
    const preAmt = pre ? pre.data.readBigUInt64LE(64) : 0n;
    const postAmt = post?.data?.[0] ? Buffer.from(post.data[0], "base64").readBigUInt64LE(64) : 0n;
    if (postAmt !== preAmt) changes.push({ mint: w.mint, symbol: w.symbol, delta: fmt(postAmt - preAmt, w.decimals) });
  });

  return { ok: true, computeUnits: v.unitsConsumed, balanceChanges: changes };
}
