import {
  ExtensionType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  getExtensionTypes,
  getTransferFeeConfig,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Risk, TokenCheck } from "./tickets.js";
import type { JupiterExtra } from "./jupiter-extra.js";

/** Well-known issuers whose mint/freeze authorities are expected (regulated stablecoins, LSTs, majors). */
const KNOWN: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: "JTO",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: "JupSOL",
};
export const knownSymbol = (mint: string) => KNOWN[mint];

const worst = (a: Risk, b: Risk): Risk => (a === "high" || b === "high" ? "high" : a === "medium" || b === "medium" ? "medium" : "low");

/**
 * On-chain token safety check, plus Jupiter Shield warnings when an API key is set.
 * Looks at what can actually hurt a holder: who can mint more, who can freeze you,
 * Token-2022 extensions that can take or tax your tokens, and holder concentration.
 */
export async function checkToken(connection: Connection, mintStr: string, jup?: JupiterExtra, symbolHint?: string): Promise<TokenCheck> {
  const mint = new PublicKey(mintStr);
  const known = KNOWN[mintStr];
  const flags: TokenCheck["flags"] = [];
  const symbol = known ?? symbolHint ?? `${mintStr.slice(0, 4)}…${mintStr.slice(-4)}`;
  if (mint.equals(NATIVE_MINT)) return { mint: mintStr, symbol: "SOL", risk: "low", flags: [{ level: "low", text: "Native SOL" }] };

  const acc = await connection.getAccountInfo(mint);
  if (!acc) return { mint: mintStr, symbol, risk: "high", flags: [{ level: "high", text: "Mint account does not exist" }] };
  const m = unpackMint(mint, acc, acc.owner);

  if (known) flags.push({ level: "low", text: `Well-known token (${known})` });
  if (m.mintAuthority) {
    flags.push({ level: known ? "low" : "medium", text: known ? "Issuer can mint more (expected for this token)" : "Someone can still mint more of this token (supply can be inflated)" });
  }
  if (m.freezeAuthority) {
    flags.push({ level: known ? "low" : "high", text: known ? "Issuer can freeze accounts (expected for this token)" : "Someone can freeze your tokens so you can't sell" });
  }

  if (acc.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const exts = getExtensionTypes(m.tlvData);
    if (exts.includes(ExtensionType.PermanentDelegate)) flags.push({ level: "high", text: "Permanent delegate: an outside account can move or burn your tokens at any time" });
    if (exts.includes(ExtensionType.NonTransferable)) flags.push({ level: "high", text: "Non-transferable token: you won't be able to sell or send it" });
    if (exts.includes(ExtensionType.DefaultAccountState)) flags.push({ level: "medium", text: "New token accounts may start frozen" });
    if (exts.includes(ExtensionType.TransferHook)) flags.push({ level: "medium", text: "Transfer hook: a custom program runs on every transfer and could block sells" });
    if (exts.includes(ExtensionType.MintCloseAuthority)) flags.push({ level: "medium", text: "Mint can be closed by its authority" });
    const fee = getTransferFeeConfig(m);
    if (fee) {
      const bps = fee.newerTransferFee.transferFeeBasisPoints;
      flags.push({ level: bps > 100 ? "high" : "medium", text: `Transfer tax of ${(bps / 100).toFixed(2)}% on every transfer` });
    }
  }

  try {
    const largest = await connection.getTokenLargestAccounts(mint);
    const supply = Number(m.supply);
    if (supply > 0 && largest.value.length) {
      const top1 = Number(largest.value[0]!.amount) / supply;
      const top10 = largest.value.slice(0, 10).reduce((s, a) => s + Number(a.amount), 0) / supply;
      if (!known && top10 > 0.8) flags.push({ level: "medium", text: `Top 10 holders own ${(top10 * 100).toFixed(0)}% of supply (may include pools/exchanges)` });
      else if (!known && top1 > 0.3) flags.push({ level: "medium", text: `Largest holder owns ${(top1 * 100).toFixed(0)}% of supply (may be a pool)` });
    }
  } catch {
    /* some RPCs restrict this call */
  }

  if (jup) {
    try {
      for (const w of await jup.shield(mintStr)) {
        const serious = w.severity === "critical" || w.severity === "warning";
        // Freeze/mint authority warnings are expected for regulated issuers (USDC, USDT…).
        flags.push({ level: serious && !known ? "medium" : "low", text: `Jupiter Shield: ${w.message ?? w.type}` });
      }
    } catch {
      /* shield is advisory */
    }
  }

  return { mint: mintStr, symbol, risk: flags.reduce<Risk>((r, f) => worst(r, f.level), "low"), flags };
}
