/**
 * Create the fee wallet's token accounts for the mints you want to earn fees in.
 * Fees on SPL inputs are skipped for any mint whose fee account doesn't exist yet
 * (so users never pay rent for your fee account).
 *
 *   FEE_KEYPAIR=~/.config/solana/fee.json pnpm fee-accounts <mint> [mint...]
 */
import { readFileSync } from "node:fs";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

const path = process.env.FEE_KEYPAIR?.replace(/^~/, process.env.HOME ?? "");
if (!path) throw new Error("set FEE_KEYPAIR to the fee wallet keypair JSON");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const connection = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");

const tx = new Transaction();
for (const m of process.argv.slice(2)) {
  const mint = new PublicKey(m);
  const program = (await connection.getAccountInfo(mint))!.owner;
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, true, program);
  console.log(`${m} → ${ata.toBase58()}`);
  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, mint, program));
}
console.log("signature:", await sendAndConfirmTransaction(connection, tx, [payer]));
