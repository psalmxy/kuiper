import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import type { SwapService } from "../service.js";
import type { JupiterExtra } from "./jupiter-extra.js";
import { simulateWithBalanceChanges, type WatchMint } from "./simulate.js";
import type { Ticket, TicketKind, TicketStore, TokenCheck } from "./tickets.js";
import { checkToken, knownSymbol } from "./token-check.js";

export const LSTS: Record<string, string> = {
  JitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  JupSOL: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
  mSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
};

const SYMBOL_TO_MINT: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  ...Object.fromEntries(Object.entries(LSTS).map(([k, v]) => [k.toUpperCase(), v])),
};

export interface ResolvedToken extends WatchMint {}

const b64 = (tx: VersionedTransaction) => Buffer.from(tx.serialize()).toString("base64");
const fromB64 = (s: string) => VersionedTransaction.deserialize(Buffer.from(s, "base64"));

export function toBaseUnits(amount: string, decimals: number): bigint {
  const v = amount.trim().replace(/,/g, "");
  if (!/^\d*\.?\d+$/.test(v)) throw new Error(`invalid amount "${amount}"`);
  const [w = "0", f = ""] = v.split(".");
  if (f.length > decimals) throw new Error(`too many decimals for this token (max ${decimals})`);
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function fromBaseUnits(raw: bigint | string, decimals: number) {
  const a = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
  return `${a / base}${frac ? "." + frac : ""}`;
}

/** Builds tickets. Each method fetches fresh state, checks tokens, simulates, and never signs. */
export class Preparer {
  constructor(
    private readonly connection: Connection,
    private readonly swaps: SwapService,
    private readonly jup: JupiterExtra,
    private readonly store: TicketStore,
  ) {}

  /** Accepts a mint address or a symbol (well-known list first, then Jupiter search, verified tokens only). */
  async resolve(token: string): Promise<ResolvedToken> {
    let mint = SYMBOL_TO_MINT[token.trim().replace(/^\$/, "").toUpperCase()];
    let symbol = mint ? token.toUpperCase().replace("JITOSOL", "JitoSOL").replace("JUPSOL", "JupSOL").replace("MSOL", "mSOL") : undefined;
    if (!mint) {
      try {
        mint = new PublicKey(token).toBase58();
      } catch {
        if (!this.jup.enabled) throw new Error(`unknown token "${token}" — pass its mint address`);
        const hits = (await this.jup.searchTokens(token)).filter((t) => t.symbol.toUpperCase() === token.toUpperCase());
        const pick = hits.find((t) => t.isVerified) ?? hits[0];
        if (!pick) throw new Error(`no token found for "${token}"`);
        if (!pick.isVerified && hits.length > 1) throw new Error(`"${token}" is ambiguous (${hits.length} tokens, none verified) — ask the user for the mint address`);
        mint = pick.id;
        symbol = pick.symbol;
      }
    }
    const info = await this.swaps.mintInfo(new PublicKey(mint));
    return { mint, symbol: symbol ?? knownSymbol(mint) ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`, decimals: info.decimals, tokenProgram: info.tokenProgram };
  }

  async balances(user: string) {
    const owner = new PublicKey(user);
    const [lamports, spl, t22] = await Promise.all([
      this.connection.getBalance(owner),
      this.connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }),
      this.connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") }),
    ]);
    const tokens = [...spl.value, ...t22.value]
      .map((a) => a.account.data.parsed.info)
      .filter((i) => Number(i.tokenAmount.amount) > 0)
      .map((i) => ({ mint: i.mint as string, symbol: knownSymbol(i.mint) ?? null, amount: i.tokenAmount.uiAmountString as string }));
    return { SOL: fromBaseUnits(BigInt(lamports), 9), tokens };
  }

  private async finalize(a: {
    kind: TicketKind;
    title: string;
    summary: string;
    details: Ticket["details"];
    tx: VersionedTransaction;
    user: string;
    watch: WatchMint[];
    checks: TokenCheck[];
    warnings?: string[];
    submit?: Ticket["submit"];
    refresh: () => Promise<Ticket>;
  }): Promise<Ticket> {
    const simulation = await simulateWithBalanceChanges(this.connection, a.tx, new PublicKey(a.user), a.watch);
    const warnings = [...(a.warnings ?? [])];
    for (const c of a.checks) if (c.risk === "high") warnings.unshift(`${c.symbol} is high risk: ${c.flags.filter((f) => f.level === "high").map((f) => f.text).join("; ")}`);
    if (!simulation.ok) warnings.unshift(`Simulation failed — this transaction would not succeed right now (${simulation.error}).`);
    return this.store.create({
      kind: a.kind,
      title: a.title,
      summary: a.summary,
      details: a.details,
      tokenChecks: a.checks,
      simulation,
      warnings,
      transaction: b64(a.tx),
      user: a.user,
      submit: a.submit ?? { via: "rpc" },
      refresh: a.refresh,
    });
  }

  async swap(p: { user: string; input: string; output: string; amount: string; slippageBps?: number; kind?: TicketKind; note?: string }): Promise<Ticket> {
    const [i, o] = await Promise.all([this.resolve(p.input), this.resolve(p.output)]);
    const slippageBps = p.slippageBps ?? 50;
    const amount = toBaseUnits(p.amount, i.decimals);
    const [built, ci, co] = await Promise.all([
      this.swaps.buildSwap({ inputMint: i.mint, outputMint: o.mint, amount, slippageBps, taker: p.user }),
      checkToken(this.connection, i.mint, this.jup.enabled ? this.jup : undefined, i.symbol),
      checkToken(this.connection, o.mint, this.jup.enabled ? this.jup : undefined, o.symbol),
    ]);
    const kind = p.kind ?? "swap";
    const out = fromBaseUnits(built.outAmount, o.decimals);
    const details = [
      { label: "You pay", value: `${p.amount} ${i.symbol}` },
      { label: "You receive (est.)", value: `${out} ${o.symbol}` },
      { label: "Minimum received", value: `${fromBaseUnits(built.minOutAmount, o.decimals)} ${o.symbol} (${slippageBps / 100}% slippage)` },
      { label: "Route", value: built.source === "kuiper" ? "Kuiper router" : "Jupiter (better price this time)" },
    ];
    if (BigInt(built.feeAmount) > 0n) details.push({ label: "Kuiper fee", value: `${fromBaseUnits(built.feeAmount, i.decimals)} ${i.symbol}` });
    if (p.note) details.push({ label: "Note", value: p.note });
    return this.finalize({
      kind,
      title: kind === "stake" ? `Stake ${p.amount} SOL → ${o.symbol}` : `Swap ${p.amount} ${i.symbol} → ${o.symbol}`,
      summary: kind === "stake"
        ? `Convert ${p.amount} SOL into ${o.symbol}, a liquid-staking token that earns staking rewards. Unstake any time by swapping back.`
        : `Swap ${p.amount} ${i.symbol} for about ${out} ${o.symbol} at the best route found.`,
      details,
      tx: fromB64(built.transaction),
      user: p.user,
      watch: [i, o],
      checks: [ci, co],
      refresh: () => this.swap(p),
    });
  }

  async stake(p: { user: string; amountSol: string; lst?: string }): Promise<Ticket> {
    const lst = p.lst && LSTS[p.lst] ? p.lst : "JitoSOL";
    return this.swap({ user: p.user, input: "SOL", output: lst, amount: p.amountSol, kind: "stake", note: "Liquid staking via swap: no lock-up, price tracks SOL plus accrued staking yield." });
  }

  async lend(p: { user: string; asset: string; amount: string }): Promise<Ticket> {
    const a = await this.resolve(p.asset);
    const amount = toBaseUnits(p.amount, a.decimals);
    const vaults = await this.jup.lendTokens();
    const vault = vaults.find((v) => v.assetAddress === a.mint);
    if (!vault) throw new Error(`Jupiter Earn has no ${a.symbol} vault (available: ${vaults.map((v) => v.symbol.replace(/^jl/, "")).join(", ")})`);
    const user = new PublicKey(p.user);
    const receiptMint = new PublicKey(vault.address);
    const receiptProgram = (await this.connection.getAccountInfo(receiptMint))!.owner;
    const [{ instructions }, check, { blockhash }] = await Promise.all([
      this.jup.lendDepositInstructions({ asset: a.mint, amount, signer: p.user }),
      checkToken(this.connection, a.mint, this.jup, a.symbol),
      this.connection.getLatestBlockhash("confirmed"),
    ]);
    const priority = await this.swaps.priorityFee();
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
      // The deposit expects the receipt-token account (e.g. jlUSDC) to exist already.
      createAssociatedTokenAccountIdempotentInstruction(user, getAssociatedTokenAddressSync(receiptMint, user, true, receiptProgram), user, receiptMint, receiptProgram),
      ...instructions.map(
        (i) =>
          new TransactionInstruction({
            programId: new PublicKey(i.programId),
            keys: i.accounts.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
            data: Buffer.from(i.data, "base64"),
          }),
      ),
    ];
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
    const receipt = { mint: vault.address, symbol: vault.symbol, decimals: vault.decimals, tokenProgram: receiptProgram };
    const apy = (Number(vault.totalRate) / 100).toFixed(2);
    return this.finalize({
      kind: "lend",
      title: `Lend ${p.amount} ${a.symbol} on Jupiter Earn`,
      summary: `Deposit ${p.amount} ${a.symbol} into Jupiter Lend's Earn vault (currently ~${apy}% APY, variable). You receive ${vault.symbol}, redeemable for your ${a.symbol} plus interest.`,
      details: [
        { label: "Deposit", value: `${p.amount} ${a.symbol}` },
        { label: "Current APY", value: `${apy}% (variable: supply ${(Number(vault.supplyRate) / 100).toFixed(2)}% + rewards ${(Number(vault.rewardsRate) / 100).toFixed(2)}%)` },
        { label: "You receive", value: `${vault.symbol} (receipt token)` },
        { label: "Protocol", value: "Jupiter Lend (Earn)" },
        { label: "Withdraw", value: "Any time, subject to available vault liquidity" },
      ],
      tx,
      user: p.user,
      watch: [a, receipt],
      checks: [check],
      warnings: ["Lending carries smart-contract risk and, in stress, temporary withdrawal delays if the vault is fully utilised."],
      refresh: () => this.lend(p),
    });
  }

  async borrow(p: { user: string; collateral: string; collateralAmount: string; borrow: string; borrowAmount: string }): Promise<Ticket> {
    const [c, b] = await Promise.all([this.resolve(p.collateral), this.resolve(p.borrow)]);
    const vaults = await this.jup.borrowVaults();
    const vault = vaults.find((v) => v.supplyToken.address === c.mint && v.borrowToken.address === b.mint);
    if (!vault) throw new Error(`no Jupiter Lend borrow market for ${c.symbol} collateral → ${b.symbol} debt`);
    const { transaction } = await this.jup.borrowOperate({
      vaultId: vault.id,
      colAmount: toBaseUnits(p.collateralAmount, c.decimals),
      debtAmount: toBaseUnits(p.borrowAmount, b.decimals),
      signer: p.user,
    });
    const [cc, cb] = await Promise.all([checkToken(this.connection, c.mint, this.jup, c.symbol), checkToken(this.connection, b.mint, this.jup, b.symbol)]);
    const details = [
      { label: "Collateral", value: `${p.collateralAmount} ${c.symbol}` },
      { label: "Borrow", value: `${p.borrowAmount} ${b.symbol}` },
      { label: "Market", value: `Jupiter Lend vault #${vault.id}` },
    ];
    if (vault.liquidationThreshold) details.push({ label: "Liquidation threshold", value: `${vault.liquidationThreshold}` });
    return this.finalize({
      kind: "borrow",
      title: `Borrow ${p.borrowAmount} ${b.symbol} against ${p.collateralAmount} ${c.symbol}`,
      summary: `Open a Jupiter Lend position: lock ${p.collateralAmount} ${c.symbol} as collateral and borrow ${p.borrowAmount} ${b.symbol}.`,
      details,
      tx: fromB64(transaction),
      user: p.user,
      watch: [c, b],
      checks: [cc, cb],
      warnings: [
        `If ${c.symbol}'s value falls far enough relative to your debt, your collateral can be liquidated. Keep a buffer and monitor the position.`,
        "Interest accrues on the borrowed amount until you repay.",
      ],
      refresh: () => this.borrow(p),
    });
  }

  async recurring(p: { user: string; input: string; output: string; totalAmount: string; numberOfOrders: number; intervalSeconds: number }): Promise<Ticket> {
    const [i, o] = await Promise.all([this.resolve(p.input), this.resolve(p.output)]);
    const inAmount = toBaseUnits(p.totalAmount, i.decimals);
    const [{ transaction, requestId }, ci, co] = await Promise.all([
      this.jup.recurringCreate({ user: p.user, inputMint: i.mint, outputMint: o.mint, inAmount, numberOfOrders: p.numberOfOrders, interval: p.intervalSeconds }),
      checkToken(this.connection, i.mint, this.jup, i.symbol),
      checkToken(this.connection, o.mint, this.jup, o.symbol),
    ]);
    const per = fromBaseUnits(inAmount / BigInt(p.numberOfOrders), i.decimals);
    const every = humanInterval(p.intervalSeconds);
    return this.finalize({
      kind: "recurring",
      title: `Buy ${o.symbol} with ${per} ${i.symbol} ${every}, ${p.numberOfOrders} times`,
      summary: `Deposit ${p.totalAmount} ${i.symbol} into a Jupiter recurring order that buys ${o.symbol} ${every} until it runs out.`,
      details: [
        { label: "Total deposit", value: `${p.totalAmount} ${i.symbol}` },
        { label: "Each buy", value: `${per} ${i.symbol}` },
        { label: "Schedule", value: `${every}, ${p.numberOfOrders} buys (${humanInterval(p.intervalSeconds * p.numberOfOrders, true)} total)` },
        { label: "Executed by", value: "Jupiter Recurring (0.1% fee per buy)" },
      ],
      tx: fromB64(transaction),
      user: p.user,
      watch: [i, o],
      checks: [ci, co],
      warnings: ["Funds sit in the recurring-order account until each buy executes; you can cancel and withdraw the rest."],
      submit: { via: "jupiter-recurring", requestId },
      refresh: () => this.recurring(p),
    });
  }

  async quote(p: { input: string; output: string; amount: string }) {
    const [i, o] = await Promise.all([this.resolve(p.input), this.resolve(p.output)]);
    const q = await this.swaps.quote({ inputMint: i.mint, outputMint: o.mint, amount: toBaseUnits(p.amount, i.decimals), slippageBps: 50 });
    return {
      input: i.symbol,
      output: o.symbol,
      best: q.best,
      kuiperOut: q.kuiper ? fromBaseUnits(q.kuiper.outAmount, o.decimals) : null,
      jupiterOut: q.jupiter ? fromBaseUnits(q.jupiter.outAmount, o.decimals) : null,
      kuiperPath: q.kuiper ? [q.kuiper.inputMint, ...q.kuiper.hops.map((h) => h.outputMint)].map((m) => knownSymbol(m.toBase58()) ?? m.toBase58()) : null,
    };
  }

  async check(token: string) {
    const t = await this.resolve(token);
    return checkToken(this.connection, t.mint, this.jup.enabled ? this.jup : undefined, t.symbol);
  }
}

function humanInterval(sec: number, total = false) {
  const units: [number, string][] = [[604_800, "week"], [86_400, "day"], [3_600, "hour"], [60, "minute"]];
  for (const [s, name] of units) {
    if (sec % s === 0) {
      const n = sec / s;
      return total ? `${n} ${name}${n === 1 ? "" : "s"}` : n === 1 ? `every ${name}` : `every ${n} ${name}s`;
    }
  }
  return total ? `${sec} seconds` : `every ${sec} seconds`;
}

export { NATIVE_MINT };
