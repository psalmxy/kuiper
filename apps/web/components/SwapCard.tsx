"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildSwap, getQuote, sendSigned, type QuoteResponse } from "@/lib/api";
import { fromBaseUnits, shortAddr, toBaseUnits } from "@/lib/format";
import { SOL_MINT, TOKENS, type Token } from "@/lib/tokens";
import { TokenSelect } from "./TokenSelect";

const SLIPPAGES = [10, 50, 100];
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));

type Status = { kind: "idle" } | { kind: "busy"; step: string } | { kind: "done"; sig: string } | { kind: "error"; msg: string };

export function SwapCard() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [inToken, setInToken] = useState<Token>(TOKENS[0]!);
  const [outToken, setOutToken] = useState<Token>(TOKENS[1]!);
  const [amountStr, setAmountStr] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [tick, setTick] = useState(0);

  const amount = useMemo(() => toBaseUnits(amountStr, inToken.decimals), [amountStr, inToken]);

  // ---- balance ----
  useEffect(() => {
    if (!publicKey) return setBalance(null);
    let cancelled = false;
    (async () => {
      try {
        if (inToken.mint === SOL_MINT) {
          const lamports = await connection.getBalance(publicKey);
          if (!cancelled) setBalance(BigInt(lamports));
        } else {
          const res = await connection.getParsedTokenAccountsByOwner(publicKey, { mint: new PublicKey(inToken.mint) });
          const total = res.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
          if (!cancelled) setBalance(total);
        }
      } catch {
        if (!cancelled) setBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicKey, inToken, connection, status.kind]);

  // ---- quote (debounced, auto-refresh every 10s) ----
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setQuoteErr(null);
    if (!amount || amount === 0n) {
      setQuote(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const q = await getQuote(
          { inputMint: inToken.mint, outputMint: outToken.mint, amount: amount.toString(), slippageBps, taker: publicKey?.toBase58() },
          ctrl.signal,
        );
        setQuote(q);
        if (!q.best) setQuoteErr(q.jupiterError ? `No route (${q.jupiterError})` : "No route for this pair yet");
      } catch (e) {
        if (!ctrl.signal.aborted) setQuoteErr((e as Error).message);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [amount, inToken, outToken, slippageBps, publicKey, tick]);

  const best = quote?.best ? quote[quote.best] : null;
  const outDisplay = best ? fromBaseUnits(best.outAmount, outToken.decimals) : "";
  const minReceived = best ? (BigInt(best.outAmount) * BigInt(10_000 - slippageBps)) / 10_000n : null;
  const insufficient = balance !== null && amount !== null && amount > balance;

  const flip = () => {
    setInToken(outToken);
    setOutToken(inToken);
    setAmountStr(outDisplay.replace(/,/g, ""));
  };

  const setMax = () => {
    if (balance === null) return;
    const reserve = inToken.mint === SOL_MINT ? 10_000_000n : 0n; // keep 0.01 SOL for fees/rent
    const max = balance > reserve ? balance - reserve : 0n;
    setAmountStr(fromBaseUnits(max, inToken.decimals, inToken.decimals).replace(/,/g, ""));
  };

  const swap = useCallback(async () => {
    if (!publicKey || !signTransaction || !amount) return;
    try {
      setStatus({ kind: "busy", step: "Building transaction…" });
      const built = await buildSwap({ inputMint: inToken.mint, outputMint: outToken.mint, amount: amount.toString(), slippageBps, taker: publicKey.toBase58() });
      const tx = VersionedTransaction.deserialize(b64ToBytes(built.transaction));

      setStatus({ kind: "busy", step: "Approve in your wallet…" });
      const signed = await signTransaction(tx);

      setStatus({ kind: "busy", step: "Sending…" });
      const { signature } = await sendSigned(bytesToB64(signed.serialize()));

      setStatus({ kind: "busy", step: "Confirming…" });
      const conf = await connection.confirmTransaction(
        { signature, blockhash: signed.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight },
        "confirmed",
      );
      if (conf.value.err) throw new Error(`Transaction failed: ${JSON.stringify(conf.value.err)}`);
      setStatus({ kind: "done", sig: signature });
      setAmountStr("");
    } catch (e) {
      setStatus({ kind: "error", msg: (e as Error).message });
    }
  }, [publicKey, signTransaction, amount, inToken, outToken, slippageBps, connection]);

  const busy = status.kind === "busy";
  const cta = !publicKey
    ? { label: "Connect wallet", action: () => setVisible(true), disabled: false }
    : !amount
      ? { label: "Enter an amount", action: undefined, disabled: true }
      : insufficient
        ? { label: `Insufficient ${inToken.symbol}`, action: undefined, disabled: true }
        : !quote?.best
          ? { label: loading ? "Finding best route…" : "No route", action: undefined, disabled: true }
          : { label: busy ? (status as { step: string }).step : "Swap", action: swap, disabled: busy };

  return (
    <section className="rounded-3xl border border-line bg-hull/90 p-3 shadow-2xl shadow-black/40">
      {/* slippage */}
      <div className="flex items-center justify-end gap-1 px-1 pb-2 text-xs text-dim">
        <span className="mr-1">Slippage</span>
        {SLIPPAGES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSlippageBps(s)}
            className={`num rounded-md px-2 py-1 transition ${slippageBps === s ? "bg-ice/15 text-ice" : "hover:text-white"}`}
          >
            {s / 100}%
          </button>
        ))}
      </div>

      {/* sell */}
      <div className="rounded-2xl border border-line bg-panel p-4">
        <div className="flex items-center justify-between text-xs text-dim">
          <span>You pay</span>
          {balance !== null && (
            <button type="button" onClick={setMax} className="num hover:text-ice">
              Balance {fromBaseUnits(balance, inToken.decimals, 4)} · MAX
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <input
            inputMode="decimal"
            placeholder="0"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value.replace(/,/g, "."))}
            className={`num w-full bg-transparent text-3xl outline-none placeholder:text-dim/50 ${insufficient ? "text-bad" : ""}`}
          />
          <TokenSelect value={inToken} onChange={setInToken} exclude={outToken.mint} />
        </div>
      </div>

      {/* flip */}
      <div className="relative z-10 -my-3 flex justify-center">
        <button
          type="button"
          onClick={flip}
          aria-label="Flip tokens"
          className="grid size-9 place-items-center rounded-xl border-4 border-hull bg-panel text-dim transition hover:rotate-180 hover:text-ice"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M8 2v12M8 14l-4-4M8 14l4-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* buy */}
      <div className="rounded-2xl border border-line bg-panel p-4">
        <div className="text-xs text-dim">You receive</div>
        <div className="mt-2 flex items-center gap-3">
          <div className={`num w-full truncate text-3xl ${loading ? "animate-pulse text-dim" : outDisplay ? "" : "text-dim/50"}`}>{outDisplay || "0"}</div>
          <TokenSelect value={outToken} onChange={setOutToken} exclude={inToken.mint} />
        </div>
      </div>

      {/* route */}
      {quote?.best && best && (
        <RoutePanel quote={quote} inToken={inToken} outToken={outToken} minReceived={minReceived!} />
      )}
      {quoteErr && <p className="px-2 pt-3 text-sm text-warn">{quoteErr}</p>}

      <button
        type="button"
        onClick={cta.action}
        disabled={cta.disabled}
        className="mt-3 h-14 w-full rounded-2xl bg-gradient-to-r from-ice-deep to-ice text-base font-semibold text-void transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:from-panel disabled:to-panel disabled:text-dim"
      >
        {cta.label}
      </button>

      {status.kind === "done" && (
        <p className="px-2 pt-3 text-sm text-ok">
          Swapped ·{" "}
          <a className="underline" href={`https://solscan.io/tx/${status.sig}`} target="_blank" rel="noreferrer">
            {shortAddr(status.sig)}
          </a>
        </p>
      )}
      {status.kind === "error" && <p className="px-2 pt-3 text-sm break-words text-bad">{status.msg}</p>}
    </section>
  );
}

function RoutePanel({ quote, inToken, outToken, minReceived }: { quote: QuoteResponse; inToken: Token; outToken: Token; minReceived: bigint }) {
  const best = quote[quote.best!]!;
  const other = quote.best === "kuiper" ? quote.jupiter : quote.kuiper;
  const rate = Number(best.outAmount) / 10 ** outToken.decimals / (Number(quote.netAmount) / 10 ** inToken.decimals);
  const edgeBps = other ? Number(((BigInt(best.outAmount) - BigInt(other.outAmount)) * 10_000n) / BigInt(other.outAmount || "1")) : null;

  return (
    <div className="mt-3 space-y-2 rounded-2xl border border-line/70 p-3 text-sm">
      <Row label="Rate">
        1 {inToken.symbol} ≈ {rate.toLocaleString("en-US", { maximumFractionDigits: 6 })} {outToken.symbol}
      </Row>
      <Row label="Route">
        <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${quote.best === "kuiper" ? "bg-ice/15 text-ice" : "bg-white/10 text-white"}`}>
          {quote.best === "kuiper" ? "Kuiper" : "Jupiter fallback"}
        </span>
        {edgeBps !== null && edgeBps > 0 && <span className="ml-2 text-xs text-ok">+{(edgeBps / 100).toFixed(2)}% vs {quote.best === "kuiper" ? "Jupiter" : "Kuiper"}</span>}
      </Row>
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {best.legs.map((l, i) => (
          <span key={i} className="num rounded-md border border-line px-2 py-0.5 text-xs text-dim">
            {l.label} {Math.round(l.percent)}%
          </span>
        ))}
      </div>
      <Row label="Minimum received">
        {fromBaseUnits(minReceived, outToken.decimals)} {outToken.symbol}
      </Row>
      {quote.platformFee !== "0" && (
        <Row label="Platform fee">
          {fromBaseUnits(quote.platformFee, inToken.decimals)} {inToken.symbol}
        </Row>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-dim">{label}</span>
      <span className="num text-right">{children}</span>
    </div>
  );
}
