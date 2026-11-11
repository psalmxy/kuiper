"use client";

import { useEffect, useRef, useState } from "react";
import { TOKENS, type Token } from "@/lib/tokens";

export function TokenSelect({ value, onChange, exclude }: { value: Token; onChange: (t: Token) => void; exclude?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full border border-line bg-hull py-1.5 pr-3 pl-1.5 text-sm font-medium transition hover:border-ice/50"
      >
        <TokenBadge symbol={value.symbol} />
        {value.symbol}
        <svg width="12" height="12" viewBox="0 0 12 12" className="text-dim" aria-hidden>
          <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <ul className="absolute right-0 z-20 mt-2 max-h-72 w-56 overflow-auto rounded-xl border border-line bg-panel p-1 shadow-2xl shadow-black/50">
          {TOKENS.filter((t) => t.mint !== exclude).map((t) => (
            <li key={t.mint}>
              <button
                type="button"
                onClick={() => {
                  onChange(t);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-hull"
              >
                <TokenBadge symbol={t.symbol} />
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{t.symbol}</span>
                  <span className="text-xs text-dim">{t.name}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TokenBadge({ symbol }: { symbol: string }) {
  // Deterministic hue per symbol — no external logo fetches.
  const hue = [...symbol].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      className="grid size-6 place-items-center rounded-full text-[10px] font-bold text-void"
      style={{ background: `hsl(${hue} 80% 70%)` }}
      aria-hidden
    >
      {symbol.slice(0, 2)}
    </span>
  );
}
