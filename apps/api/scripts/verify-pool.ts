/**
 * Quote-parity check against live mainnet state — Kuiper's version of Jupiter's jupiter-amm-test-kit.
 *
 * Takes a pool, quotes a swap with our adapter, then simulates the *real* swap instruction
 * from a wallet that actually holds the input token, and compares the simulated output
 * delta with our quote. A correct adapter matches to the base unit.
 *
 *   pnpm verify:pool <kind> <poolAddress> <amountInBaseUnits> [inputMint]
 *   pnpm verify:pool orca-whirlpool Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE 1000000000
 */
import { PoolCache, type PoolKind } from "@kuiper/core";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

const [kind, address, amountArg, inputArg] = process.argv.slice(2);
if (!kind || !address || !amountArg) {
  console.error("usage: verify-pool <raydium-cpmm|orca-whirlpool|meteora-dlmm> <pool> <amount> [inputMint]");
  process.exit(1);
}
const connection = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const amount = BigInt(amountArg);

const cache = new PoolCache(connection, [{ kind: kind as PoolKind, address }]);
await cache.init();
const amm = cache.amms[0];
if (!amm || !amm.isActive()) throw new Error("pool failed to load or is inactive");

const [m0, m1] = amm.reserveMints() as [PublicKey, PublicKey];
const inputMint = inputArg ? new PublicKey(inputArg) : m0;
const outputMint = inputMint.equals(m0) ? m1 : m0;
const quote = amm.quote({ inputMint, outputMint, amount });
console.log(`${amm.label} ${address}\n  quote: ${amount} ${inputMint.toBase58().slice(0, 6)}… → ${quote.outAmount} ${outputMint.toBase58().slice(0, 6)}…`);

// Find a real holder. Cheap path first: well-known high-balance wallets (or HOLDER=<wallet>).
// SOL input is wrapped inside the simulated tx, so the holder only needs lamports.
const programOf = async (mint: PublicKey) => (await connection.getAccountInfo(mint))!.owner;
const [inProg, outProg] = await Promise.all([programOf(inputMint), programOf(outputMint)]);
const inIsSol = inputMint.equals(NATIVE_MINT);
const CANDIDATES = [
  process.env.HOLDER,
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhJibQDc", // exchange hot wallets (public)
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S",
  "FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5",
].filter(Boolean) as string[];
let holder: PublicKey | null = null;
for (const c of CANDIDATES) {
  const owner = new PublicKey(c);
  const acc = await connection.getAccountInfo(owner);
  if (!acc?.owner.equals(SystemProgram.programId)) continue;
  if (inIsSol) {
    if (BigInt(acc.lamports) > amount + 100_000_000n) { holder = owner; break; }
  } else {
    const bal = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(inputMint, owner, true, inProg)).catch(() => null);
    if (bal && BigInt(bal.value.amount) >= amount && acc.lamports > 10_000_000) { holder = owner; break; }
  }
}
if (!holder) {
  const largest = await connection.getTokenLargestAccounts(inputMint);
  for (const acc of largest.value.slice(0, 15)) {
    if (BigInt(acc.amount) < amount) continue;
    const info = await connection.getParsedAccountInfo(acc.address);
    const owner = new PublicKey((info.value?.data as any).parsed.info.owner);
    const ownerAcc = await connection.getAccountInfo(owner);
    const isAta = getAssociatedTokenAddressSync(inputMint, owner, true, inProg).equals(acc.address);
    if (ownerAcc?.owner.equals(SystemProgram.programId) && ownerAcc.lamports > 10_000_000 && isAta) {
      holder = owner;
      break;
    }
  }
}
if (!holder) throw new Error("no suitable holder found — pass HOLDER=<wallet that holds the input token>");

const src = getAssociatedTokenAddressSync(inputMint, holder, true, inProg);
const dst = getAssociatedTokenAddressSync(outputMint, holder, true, outProg);
const pre = await connection.getAccountInfo(dst);
const preAmount = pre ? pre.data.readBigUInt64LE(64) : 0n;

const ixs = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  ...(inIsSol
    ? [
        createAssociatedTokenAccountIdempotentInstruction(holder, src, holder, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: holder, toPubkey: src, lamports: amount }),
        createSyncNativeInstruction(src),
      ]
    : []),
  createAssociatedTokenAccountIdempotentInstruction(holder, dst, holder, outputMint, outProg),
  ...(await amm.swapInstructions({
    user: holder,
    inputMint,
    outputMint,
    userSourceTokenAccount: src,
    userDestinationTokenAccount: dst,
    inAmount: amount,
    minOutAmount: 0n,
  })),
];
const { blockhash } = await connection.getLatestBlockhash();
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: holder, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
const sim = await connection.simulateTransaction(tx, {
  sigVerify: false,
  replaceRecentBlockhash: true,
  accounts: { encoding: "base64", addresses: [dst.toBase58()] },
});
if (sim.value.err) {
  console.error("  simulation error:", JSON.stringify(sim.value.err));
  console.error((sim.value.logs ?? []).slice(-10).join("\n"));
  process.exit(1);
}
const post = Buffer.from(sim.value.accounts![0]!.data[0]!, "base64").readBigUInt64LE(64);
const actual = post - preAmount;
const diff = actual - quote.outAmount;
const bps = quote.outAmount > 0n ? Number((diff * 1_000_000n) / quote.outAmount) / 100 : 0;
console.log(`  simulated: ${actual}  (holder ${holder.toBase58()}, ${sim.value.unitsConsumed} CU)`);
console.log(diff === 0n ? "  ✅ exact match" : `  ⚠️  diff ${diff} (${bps} bps) — check fees/rounding in the adapter`);
cache.stop();
process.exit(diff === 0n ? 0 : 2);
