/**
 * Live smoke test for the agent backends: builds real tickets (token check, stake, lend, recurring,
 * borrow) for a public exchange wallet and prints each simulation. Nothing is signed or sent.
 *   pnpm smoke:agent [check|stake|lend|recurring|borrow]
 */
import { PoolCache, Router } from "@kuiper/core";
import { Connection } from "@solana/web3.js";
import { JupiterExtra } from "../src/agent/jupiter-extra.js";
import { Preparer } from "../src/agent/preparer.js";
import { TicketStore } from "../src/agent/tickets.js";
import { JupiterClient } from "../src/jupiter.js";
import { SwapService } from "../src/service.js";

const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const cache = new PoolCache(conn, [], () => {});
const swaps = new SwapService(conn, cache, new Router(() => cache.amms), new JupiterClient(process.env.JUP_API_KEY ?? ""), { feeBps: 0 });
const jup = new JupiterExtra(process.env.JUP_API_KEY ?? "");
const prep = new Preparer(conn, swaps, jup, new TicketStore());
const USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (name: string, t: any) =>
  console.log(`\n== ${name}: ${t.title}\n   sim ok=${t.simulation.ok} ${t.simulation.error ?? ""} CU=${t.simulation.computeUnits}\n   changes=${JSON.stringify(t.simulation.balanceChanges)}\n   risk=${t.tokenChecks.map((c: any) => c.symbol + ":" + c.risk).join(",")} warnings=${t.warnings.length}${t.simulation.logsTail ? "\n   logs=" + t.simulation.logsTail.slice(-3).join(" | ") : ""}`);
const run = async (name: string, f: () => Promise<any>) => {
  try { const r = await f(); name.startsWith("check") ? console.log(`\n== ${name}: risk=${r.risk}`, r.flags.map((x: any) => `[${x.level}] ${x.text}`)) : show(name, r); }
  catch (e) { console.log(`\n== ${name}: ERROR ${(e as Error).message.slice(0, 400)}`); }
  await wait(2500);
};
const which = process.argv[2] ?? "all";
if (which === "all" || which === "check") {
  await run("check BONK", () => prep.check("BONK"));
  await run("check USDC", () => prep.check("USDC"));
}
if (which === "all" || which === "stake") await run("stake", () => prep.stake({ user: USER, amountSol: "1" }));
if (which === "all" || which === "lend") await run("lend", () => prep.lend({ user: USER, asset: "USDC", amount: "100" }));
if (which === "all" || which === "recurring") await run("recurring", () => prep.recurring({ user: USER, input: "USDC", output: "JUP", totalAmount: "300", numberOfOrders: 3, intervalSeconds: 86400 }));
if (which === "all" || which === "borrow") await run("borrow", () => prep.borrow({ user: USER, collateral: "SOL", collateralAmount: "2", borrow: "USDC", borrowAmount: "50" }));
process.exit(0);
