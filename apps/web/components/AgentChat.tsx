"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { agentChat, type Ticket } from "@/lib/api";
import { TicketCard } from "./TicketCard";

type Msg = { role: "user" | "agent"; text: string; tickets?: Ticket[] };

const EXAMPLES = [
  "Swap 2 SOL to USDC",
  "Stake 5 SOL",
  "Is BONK safe to buy?",
  "Lend 500 USDC",
  "Buy JUP with 300 USDC every week for 6 weeks",
];

export function AgentChat() {
  const { publicKey } = useWallet();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from smooth scrollIntoView.
    void endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const r = await agentChat({ sessionId, message: text, wallet: publicKey?.toBase58() });
      setSessionId(r.sessionId);
      setMsgs((m) => [...m, { role: "agent", text: r.reply, tickets: r.tickets }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "agent", text: `⚠ ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {msgs.length === 0 && (
        <div className="rounded-2xl border border-line bg-hull/80 p-4">
          <p className="text-sm text-dim">Try:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {EXAMPLES.map((e) => (
              <button key={e} type="button" onClick={() => send(e)} className="rounded-full border border-line px-3 py-1.5 text-sm hover:border-ice/50 hover:text-ice">
                {e}
              </button>
            ))}
          </div>
          {!publicKey && <p className="mt-3 text-xs text-warn">Connect a wallet so the agent can read balances and build tickets for you.</p>}
        </div>
      )}

      {msgs.map((m, i) =>
        m.role === "user" ? (
          <div key={i} className="self-end rounded-2xl rounded-br-md bg-ice/12 px-4 py-2.5 text-sm">
            {m.text}
          </div>
        ) : (
          <div key={i} className="flex flex-col gap-3">
            {m.text && <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-panel px-4 py-2.5 text-sm whitespace-pre-wrap">{m.text}</div>}
            {m.tickets?.map((t) => <TicketCard key={t.id} initial={t} />)}
          </div>
        ),
      )}
      {busy && <div className="w-fit animate-pulse rounded-2xl bg-panel px-4 py-2.5 text-sm text-dim">Routing, checking tokens, simulating…</div>}
      <div ref={endRef} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="fixed inset-x-0 bottom-0 border-t border-line/60 bg-void/85 backdrop-blur"
      >
        <div className="mx-auto flex max-w-[720px] gap-2 px-4 py-4">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Swap, stake, lend, borrow or set up a recurring buy…"
            className="h-12 flex-1 rounded-xl border border-line bg-hull px-4 text-sm outline-none focus:border-ice/50"
          />
          <button type="submit" disabled={busy || !input.trim()} className="h-12 rounded-xl bg-ice px-5 text-sm font-semibold text-void disabled:bg-panel disabled:text-dim">
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
