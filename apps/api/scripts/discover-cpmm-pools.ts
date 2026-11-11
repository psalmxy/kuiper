/**
 * Find Raydium CPMM pools for a token pair straight from chain (getProgramAccounts + memcmp),
 * the way an aggregator indexes a DEX without depending on its API.
 *
 *   pnpm discover:cpmm <mintA> <mintB>
 *
 * Needs an RPC that allows filtered getProgramAccounts (Helius/Triton/QuickNode do).
 */
import { POOL_STATE_DISCRIMINATOR, RAYDIUM_CPMM_PROGRAM_ID, decodeCpmmPool } from "@kuiper/core";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";

const [a, b] = process.argv.slice(2).map((s) => new PublicKey(s));
if (!a || !b) throw new Error("usage: discover-cpmm-pools <mintA> <mintB>");
const connection = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");

const search = (m0: PublicKey, m1: PublicKey) =>
  connection.getProgramAccounts(RAYDIUM_CPMM_PROGRAM_ID, {
    filters: [
      { dataSize: 637 },
      { memcmp: { offset: 0, bytes: bs58.encode(POOL_STATE_DISCRIMINATOR) } },
      { memcmp: { offset: 168, bytes: m0.toBase58() } },
      { memcmp: { offset: 200, bytes: m1.toBase58() } },
    ],
  });

const found = [...(await search(a, b)), ...(await search(b, a))];
const rows = [];
for (const { pubkey, account } of found) {
  const p = decodeCpmmPool(account.data);
  const [v0, v1] = await Promise.all([connection.getTokenAccountBalance(p.token0Vault), connection.getTokenAccountBalance(p.token1Vault)]);
  rows.push({ pool: pubkey.toBase58(), reserve0: v0.value.uiAmountString, reserve1: v1.value.uiAmountString });
}
rows.sort((x, y) => Number(y.reserve1) - Number(x.reserve1));
console.table(rows);
console.log("\nAdd to apps/api/src/pools.json:");
for (const r of rows.slice(0, 3)) console.log(JSON.stringify({ kind: "raydium-cpmm", address: r.pool }) + ",");
