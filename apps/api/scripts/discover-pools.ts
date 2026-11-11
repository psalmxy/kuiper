/**
 * Index pools straight from chain for a set of token pairs across Orca Whirlpool, Meteora DLMM
 * and Raydium CPMM (getProgramAccounts + memcmp on the mint fields), rank them by quote-side
 * liquidity, and write the best ones to src/pools.json.
 *
 *   pnpm discover:pools            # default pair list
 *   pnpm discover:pools --dry      # print only
 *
 * Offsets verified against live accounts:
 *   Whirlpool: mints 101/181, vaults 133/213 · DLMM LbPair: mints 88/120, reserves 152/184 · CPMM: mints 168/200, vaults 72/104
 */
import { writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const DRY = process.argv.includes("--dry");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const M = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  mSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  JupSOL: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
} as const;
type Sym = keyof typeof M;

// [base, quote] — quote side is used to rank liquidity
const PAIRS: [Sym, Sym][] = [
  ["SOL", "USDC"], ["SOL", "USDT"], ["USDT", "USDC"],
  ["JUP", "SOL"], ["JUP", "USDC"], ["JTO", "SOL"], ["JTO", "USDC"], ["RAY", "SOL"], ["RAY", "USDC"],
  ["BONK", "SOL"], ["BONK", "USDC"], ["JitoSOL", "SOL"], ["mSOL", "SOL"], ["JupSOL", "SOL"],
];
const PER_DEX_PER_PAIR: Record<Kind, number> = { "orca-whirlpool": 2, "meteora-dlmm": 1, "raydium-cpmm": 1 };

type Kind = "orca-whirlpool" | "meteora-dlmm" | "raydium-cpmm";
const DEX: Record<Kind, { program: string; offA: number; offB: number; vaultA: number; vaultB: number; size?: number }> = {
  "orca-whirlpool": { program: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", offA: 101, offB: 181, vaultA: 133, vaultB: 213, size: 653 },
  "meteora-dlmm": { program: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", offA: 88, offB: 120, vaultA: 152, vaultB: 184, size: 904 },
  "raydium-cpmm": { program: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", offA: 168, offB: 200, vaultA: 72, vaultB: 104, size: 637 },
};

const decimals = new Map<string, number>();
async function dec(mint: string) {
  if (!decimals.has(mint)) decimals.set(mint, (await connection.getAccountInfo(new PublicKey(mint)))!.data.readUInt8(44));
  return decimals.get(mint)!;
}

/** All pools for a pair on one DEX, with the quote-side balance — 2 gPA + 1 batched vault read. */
async function find(kind: Kind, a: string, b: string, quote: string) {
  const d = DEX[kind];
  const run = (x: string, y: string) =>
    connection.getProgramAccounts(new PublicKey(d.program), {
      filters: [...(d.size ? [{ dataSize: d.size }] : []), { memcmp: { offset: d.offA, bytes: x } }, { memcmp: { offset: d.offB, bytes: y } }],
    });
  const pools = [...(await run(a, b)), ...(await run(b, a))];
  const vaults = pools.map(({ account }) => {
    const mintA = new PublicKey(account.data.subarray(d.offA, d.offA + 32)).toBase58();
    const off = mintA === quote ? d.vaultA : d.vaultB;
    return new PublicKey(account.data.subarray(off, off + 32));
  });
  const balances: number[] = [];
  for (let i = 0; i < vaults.length; i += 100) {
    const accs = await connection.getMultipleAccountsInfo(vaults.slice(i, i + 100));
    for (const acc of accs) balances.push(acc ? Number(acc.data.readBigUInt64LE(64)) : 0);
  }
  const q = 10 ** (await dec(quote));
  await sleep(300);
  return pools.map((p, i) => ({ pool: p.pubkey, liq: balances[i]! / q }));
}

const chosen: { kind: Kind; address: string; note: string }[] = [];
for (const [base, quote] of PAIRS) {
  for (const kind of Object.keys(DEX) as Kind[]) {
    let ranked: { pool: PublicKey; liq: number }[];
    try {
      ranked = await find(kind, M[base], M[quote], M[quote]);
    } catch (e) {
      console.warn(`  ${kind} ${base}/${quote}: ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    ranked.sort((x, y) => y.liq - x.liq);
    const top = ranked.filter((r) => r.liq > 0).slice(0, PER_DEX_PER_PAIR[kind]);
    console.log(`${base}/${quote} ${kind}: ${ranked.length} pools; top: ${top.map((t) => `${t.pool.toBase58().slice(0, 6)}… ${t.liq.toFixed(1)} ${quote}`).join(", ") || "—"}`);
    for (const t of top) chosen.push({ kind, address: t.pool.toBase58(), note: `${base}/${quote} (${Math.round(t.liq).toLocaleString()} ${quote} side)` });
  }
}

console.log(`\n${chosen.length} pools selected`);
if (!DRY) {
  writeFileSync(new URL("../src/pools.json", import.meta.url), JSON.stringify(chosen, null, 2) + "\n");
  console.log("wrote src/pools.json");
}
