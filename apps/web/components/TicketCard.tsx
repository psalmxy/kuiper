"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { refreshTicket, submitTicket, type Risk, type Ticket } from "@/lib/api";
import { shortAddr } from "@/lib/format";

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));

const RISK_STYLE: Record<Risk, string> = {
  low: "bg-ok/12 text-ok",
  medium: "bg-warn/12 text-warn",
  high: "bg-bad/15 text-bad",
};
const KIND_LABEL: Record<Ticket["kind"], string> = { swap: "Swap", stake: "Stake", lend: "Lend", borrow: "Borrow", recurring: "Recurring buy" };

type Phase = { k: "idle" } | { k: "busy"; step: string } | { k: "done"; sig: string } | { k: "error"; msg: string } | { k: "discarded" };

export function TicketCard({ initial }: { initial: Ticket }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [t, setT] = useState(initial);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsLeft = Math.max(0, Math.round((t.expiresAt - now) / 1000));
  const expired = secondsLeft === 0;
  const wrongWallet = publicKey && publicKey.toBase58() !== t.user;
  const canApprove = t.simulation.ok && !expired && !wrongWallet && phase.k === "idle" && !!signTransaction;

  const approve = async () => {
    if (!signTransaction) return;
    try {
      setPhase({ k: "busy", step: "Approve in your wallet…" });
      const signed = await signTransaction(VersionedTransaction.deserialize(b64ToBytes(t.transaction)));
      setPhase({ k: "busy", step: "Submitting…" });
      const { signature } = await submitTicket(t.id, bytesToB64(signed.serialize()));
      setPhase({ k: "busy", step: "Confirming…" });
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature, ...bh }, "confirmed");
      setPhase({ k: "done", sig: signature });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message });
    }
  };

  const refresh = async () => {
    setPhase({ k: "busy", step: "Re-checking route and simulation…" });
    try {
      setT(await refreshTicket(t.id));
      setPhase({ k: "idle" });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message });
    }
  };

  if (phase.k === "discarded") {
    return <div className="rounded-2xl border border-dashed border-line px-4 py-3 text-sm text-dim">Ticket discarded: {t.title}</div>;
  }

  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-hull">
      {/* header */}
      <header className="flex items-start justify-between gap-3 border-b border-line/70 px-4 py-3">
        <div>
          <div className="text-[11px] font-medium tracking-wider text-ice uppercase">{KIND_LABEL[t.kind]} ticket</div>
          <h3 className="mt-0.5 font-semibold">{t.title}</h3>
          <p className="mt-1 text-sm text-dim">{t.summary}</p>
        </div>
        <span className={`num shrink-0 rounded-md px-2 py-1 text-xs ${expired ? "bg-white/5 text-dim" : "bg-ice/10 text-ice"}`}>
          {expired ? "expired" : `${secondsLeft}s`}
        </span>
      </header>

      {/* warnings first */}
      {t.warnings.length > 0 && (
        <ul className="space-y-1 border-b border-line/70 bg-warn/5 px-4 py-3 text-sm text-warn">
          {t.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
        {/* details */}
        <section>
          <h4 className="mb-2 text-xs font-medium tracking-wider text-dim uppercase">Details</h4>
          <dl className="space-y-1.5 text-sm">
            {t.details.map((d) => (
              <div key={d.label} className="flex justify-between gap-3">
                <dt className="text-dim">{d.label}</dt>
                <dd className="num text-right">{d.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* simulation */}
        <section>
          <h4 className="mb-2 text-xs font-medium tracking-wider text-dim uppercase">
            Simulation {t.simulation.ok ? <span className="text-ok">· passed</span> : <span className="text-bad">· failed</span>}
          </h4>
          {t.simulation.ok ? (
            <dl className="space-y-1.5 text-sm">
              {t.simulation.balanceChanges.map((b) => (
                <div key={b.mint + b.symbol} className="flex justify-between gap-3">
                  <dt className="text-dim">{b.symbol}</dt>
                  <dd className={`num ${b.delta.startsWith("-") ? "text-bad" : "text-ok"}`}>{b.delta}</dd>
                </div>
              ))}
              {t.simulation.computeUnits && <div className="num pt-1 text-xs text-dim">{t.simulation.computeUnits.toLocaleString()} compute units</div>}
            </dl>
          ) : (
            <pre className="max-h-32 overflow-auto rounded-lg bg-void p-2 text-xs whitespace-pre-wrap text-bad">
              {t.simulation.error}
              {t.simulation.logsTail?.length ? "\n" + t.simulation.logsTail.join("\n") : ""}
            </pre>
          )}
        </section>
      </div>

      {/* token checks */}
      <section className="border-t border-line/70 px-4 py-3">
        <h4 className="mb-2 text-xs font-medium tracking-wider text-dim uppercase">Token checks</h4>
        <div className="flex flex-wrap gap-2">
          {t.tokenChecks.map((c) => (
            <button
              key={c.mint}
              type="button"
              onClick={() => setOpen(open === c.mint ? null : c.mint)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium ${RISK_STYLE[c.risk]}`}
            >
              {c.symbol} · {c.risk} risk
            </button>
          ))}
        </div>
        {t.tokenChecks
          .filter((c) => c.mint === open)
          .map((c) => (
            <ul key={c.mint} className="mt-2 space-y-1 text-sm">
              <li className="num text-xs text-dim">{c.mint}</li>
              {c.flags.map((f, i) => (
                <li key={i} className={f.level === "high" ? "text-bad" : f.level === "medium" ? "text-warn" : "text-dim"}>
                  • {f.text}
                </li>
              ))}
            </ul>
          ))}
      </section>

      {/* actions */}
      <footer className="flex flex-wrap items-center gap-2 border-t border-line/70 px-4 py-3">
        {phase.k === "done" ? (
          <p className="text-sm text-ok">
            Approved and confirmed ·{" "}
            <a className="underline" href={`https://solscan.io/tx/${phase.sig}`} target="_blank" rel="noreferrer">
              {shortAddr(phase.sig)}
            </a>
          </p>
        ) : (
          <>
            {expired ? (
              <button type="button" onClick={refresh} disabled={phase.k === "busy"} className="h-10 rounded-xl bg-panel px-4 text-sm font-medium hover:brightness-125">
                Refresh ticket
              </button>
            ) : (
              <button
                type="button"
                onClick={approve}
                disabled={!canApprove}
                className="h-10 rounded-xl bg-gradient-to-r from-ice-deep to-ice px-4 text-sm font-semibold text-void transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:from-panel disabled:to-panel disabled:text-dim"
              >
                {phase.k === "busy" ? phase.step : "Approve in wallet"}
              </button>
            )}
            <button type="button" onClick={() => setPhase({ k: "discarded" })} className="h-10 rounded-xl px-3 text-sm text-dim hover:text-white">
              Discard
            </button>
            {wrongWallet && <span className="text-xs text-warn">Connected wallet differs from the ticket&apos;s wallet.</span>}
            {!t.simulation.ok && <span className="text-xs text-dim">Can&apos;t approve a ticket that failed simulation.</span>}
          </>
        )}
        {phase.k === "error" && <p className="w-full text-sm break-words text-bad">{phase.msg}</p>}
      </footer>
    </article>
  );
}
