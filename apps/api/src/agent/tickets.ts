import { randomUUID } from "node:crypto";

export type TicketKind = "swap" | "stake" | "lend" | "borrow" | "recurring";
export type Risk = "low" | "medium" | "high";

export interface TokenCheck {
  mint: string;
  symbol: string;
  risk: Risk;
  flags: { level: Risk; text: string }[];
}

export interface BalanceChange {
  mint: string;
  symbol: string;
  /** Human-readable signed amount, e.g. "-1.5" or "+243.18". */
  delta: string;
}

export interface Simulation {
  ok: boolean;
  error?: string;
  computeUnits?: number;
  balanceChanges: BalanceChange[];
  logsTail?: string[];
}

/**
 * A ticket is everything the user needs to decide, in plain language, plus the unsigned
 * transaction. The server never signs: the only way a ticket executes is the user's wallet
 * signing exactly this transaction.
 */
export interface Ticket {
  id: string;
  kind: TicketKind;
  title: string;
  /** One-line plain-English description. */
  summary: string;
  /** Key facts, label → value. */
  details: { label: string; value: string }[];
  tokenChecks: TokenCheck[];
  simulation: Simulation;
  warnings: string[];
  /** Unsigned base64 VersionedTransaction for the user's wallet. */
  transaction: string;
  user: string;
  createdAt: number;
  expiresAt: number;
  /** How a signed transaction gets submitted. */
  submit: { via: "rpc" } | { via: "jupiter-recurring"; requestId: string };
  /** Re-runs the preparation with fresh state (new blockhash, new quote). Not serialised. */
  refresh?: () => Promise<Ticket>;
  status: "ready" | "submitted" | "confirmed" | "failed" | "expired";
  signature?: string;
}

const TTL_MS = 60_000; // ~150 blocks of blockhash validity, minus margin

export class TicketStore {
  private tickets = new Map<string, Ticket>();

  create(t: Omit<Ticket, "id" | "createdAt" | "expiresAt" | "status">): Ticket {
    const now = Date.now();
    const ticket: Ticket = { ...t, id: randomUUID(), createdAt: now, expiresAt: now + TTL_MS, status: "ready" };
    this.tickets.set(ticket.id, ticket);
    this.gc();
    return ticket;
  }

  get(id: string) {
    const t = this.tickets.get(id);
    if (t && t.status === "ready" && Date.now() > t.expiresAt) t.status = "expired";
    return t;
  }

  replace(oldId: string, fresh: Ticket) {
    this.tickets.delete(oldId);
    this.tickets.set(fresh.id, fresh);
  }

  private gc() {
    const cutoff = Date.now() - 3_600_000;
    for (const [id, t] of this.tickets) if (t.createdAt < cutoff) this.tickets.delete(id);
  }
}

/** JSON-safe view (drops the refresh closure). */
export const ticketJson = (t: Ticket) => {
  const { refresh: _r, ...rest } = t;
  return rest;
};
