import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { LSTS, type Preparer } from "./preparer.js";
import { ticketJson, type Ticket } from "./tickets.js";

type MessageParam = Anthropic.Messages.MessageParam;
type ToolDef = Anthropic.Messages.Tool;

const SYSTEM = `You are Kuiper, a DeFi assistant for Solana. You do the legwork for swaps, staking, lending/borrowing and recurring buys: find the best route, check the tokens, simulate, and hand the user a ticket.

Hard rules:
- You can never move funds. You only PREPARE tickets. A ticket executes only if the user approves it in their own wallet. Never say a trade "is done" or "was executed" — say the ticket is ready for their approval.
- To act, call the matching prepare_* tool. One ticket per action. If the user asks for several actions, prepare several tickets.
- If a required detail is missing (amount, which token, schedule), ask one short question instead of guessing. "Half my SOL" etc: call get_balances first and compute it, leaving ~0.01 SOL for fees.
- Token names can be ambiguous. If resolution fails or a token is high risk, tell the user plainly and suggest checking the mint address.
- After preparing, summarise the ticket in 2-4 short lines: what it does, the key number(s), and any warning. Point out failed simulations and high-risk flags first.
- "Stake" means liquid staking via an LST (${Object.keys(LSTS).join(", ")}; default JitoSOL). "Loan" can mean lending (earn interest: prepare_lend) or borrowing (prepare_borrow) — ask if unclear.
- Don't give investment advice or predict prices. You can explain risks and mechanics.
- Be concise. Use the token symbols the user used.`;

const TOOLS: ToolDef[] = [
  {
    name: "get_balances",
    description: "The connected wallet's SOL and token balances.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_token",
    description: "Safety check for a token: mint/freeze authority, Token-2022 traps (permanent delegate, transfer tax, non-transferable), holder concentration, Jupiter Shield warnings.",
    input_schema: { type: "object", properties: { token: { type: "string", description: "Symbol (e.g. BONK) or mint address" } }, required: ["token"] },
  },
  {
    name: "get_quote",
    description: "Price check only (no ticket): best output from Kuiper's router vs Jupiter.",
    input_schema: {
      type: "object",
      properties: { input: { type: "string" }, output: { type: "string" }, amount: { type: "string", description: "Human amount of the input token, e.g. '1.5'" } },
      required: ["input", "output", "amount"],
    },
  },
  {
    name: "prepare_swap",
    description: "Prepare a swap ticket (best route, token checks, simulation).",
    input_schema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Token to sell: symbol or mint" },
        output: { type: "string", description: "Token to buy: symbol or mint" },
        amount: { type: "string", description: "Human amount of the input token" },
        slippageBps: { type: "integer", description: "Default 50 (0.5%)" },
      },
      required: ["input", "output", "amount"],
    },
  },
  {
    name: "prepare_stake",
    description: "Prepare a liquid-staking ticket: SOL → LST.",
    input_schema: {
      type: "object",
      properties: { amountSol: { type: "string" }, lst: { type: "string", enum: Object.keys(LSTS) } },
      required: ["amountSol"],
    },
  },
  {
    name: "prepare_lend",
    description: "Prepare a ticket to deposit a token into Jupiter Lend Earn to earn interest.",
    input_schema: { type: "object", properties: { asset: { type: "string" }, amount: { type: "string" } }, required: ["asset", "amount"] },
  },
  {
    name: "prepare_borrow",
    description: "Prepare a ticket to borrow against collateral on Jupiter Lend (opens a new position).",
    input_schema: {
      type: "object",
      properties: {
        collateral: { type: "string" },
        collateralAmount: { type: "string" },
        borrow: { type: "string" },
        borrowAmount: { type: "string" },
      },
      required: ["collateral", "collateralAmount", "borrow", "borrowAmount"],
    },
  },
  {
    name: "prepare_recurring",
    description: "Prepare a recurring-buy (DCA) ticket: spend totalAmount of input over numberOfOrders buys, intervalSeconds apart.",
    input_schema: {
      type: "object",
      properties: {
        input: { type: "string" },
        output: { type: "string" },
        totalAmount: { type: "string" },
        numberOfOrders: { type: "integer", minimum: 2 },
        intervalSeconds: { type: "integer", description: "e.g. 86400 = daily, 604800 = weekly" },
      },
      required: ["input", "output", "totalAmount", "numberOfOrders", "intervalSeconds"],
    },
  },
];

const ticketBrief = (t: Ticket) => ({
  ticketId: t.id,
  title: t.title,
  details: t.details,
  simulation: t.simulation.ok ? { ok: true, balanceChanges: t.simulation.balanceChanges } : { ok: false, error: t.simulation.error },
  tokenRisk: t.tokenChecks.map((c) => ({ symbol: c.symbol, risk: c.risk })),
  warnings: t.warnings,
});

export class DefiAgent {
  private client: Anthropic;
  private sessions = new Map<string, { messages: MessageParam[]; at: number }>();

  constructor(apiKey: string, private readonly model: string, private readonly prep: Preparer, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey });
  }

  async chat(sessionId: string | undefined, text: string, wallet: string | undefined) {
    const id = sessionId && this.sessions.has(sessionId) ? sessionId : randomUUID();
    const session = this.sessions.get(id) ?? { messages: [], at: Date.now() };
    this.sessions.set(id, session);
    session.at = Date.now();
    session.messages.push({ role: "user", content: wallet ? text : `${text}\n\n[No wallet connected]` });

    const tickets: Ticket[] = [];
    let reply = "";
    for (let round = 0; round < 8; round++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM,
        tools: TOOLS,
        messages: session.messages,
      });
      session.messages.push({ role: "assistant", content: res.content });
      reply = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      if (res.stop_reason !== "tool_use") break;

      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        try {
          const out = await this.run(block.name, block.input as Record<string, unknown>, wallet, tickets);
          results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${(e as Error).message}`, is_error: true });
        }
      }
      session.messages.push({ role: "user", content: results });
    }
    this.gc();
    return { sessionId: id, reply, tickets: tickets.map(ticketJson) };
  }

  private async run(name: string, input: Record<string, any>, wallet: string | undefined, tickets: Ticket[]) {
    const needWallet = () => {
      if (!wallet) throw new Error("No wallet connected. Ask the user to connect their wallet first.");
      return wallet;
    };
    const keep = (t: Ticket) => {
      tickets.push(t);
      return ticketBrief(t);
    };
    switch (name) {
      case "get_balances":
        return this.prep.balances(needWallet());
      case "check_token":
        return this.prep.check(input.token);
      case "get_quote":
        return this.prep.quote({ input: input.input, output: input.output, amount: String(input.amount) });
      case "prepare_swap":
        return keep(await this.prep.swap({ user: needWallet(), input: input.input, output: input.output, amount: String(input.amount), slippageBps: input.slippageBps }));
      case "prepare_stake":
        return keep(await this.prep.stake({ user: needWallet(), amountSol: String(input.amountSol), lst: input.lst }));
      case "prepare_lend":
        return keep(await this.prep.lend({ user: needWallet(), asset: input.asset, amount: String(input.amount) }));
      case "prepare_borrow":
        return keep(
          await this.prep.borrow({
            user: needWallet(),
            collateral: input.collateral,
            collateralAmount: String(input.collateralAmount),
            borrow: input.borrow,
            borrowAmount: String(input.borrowAmount),
          }),
        );
      case "prepare_recurring":
        return keep(
          await this.prep.recurring({
            user: needWallet(),
            input: input.input,
            output: input.output,
            totalAmount: String(input.totalAmount),
            numberOfOrders: Number(input.numberOfOrders),
            intervalSeconds: Number(input.intervalSeconds),
          }),
        );
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  private gc() {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, s] of this.sessions) if (s.at < cutoff) this.sessions.delete(k);
  }
}
