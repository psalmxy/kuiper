"use client";

import dynamic from "next/dynamic";

// Wallet button touches window; render client-side only.
const WalletMultiButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

export function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-line/60 bg-void/70 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
        <div className="flex items-center gap-2.5">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
            <circle cx="16" cy="16" r="5" fill="#8be3ff" />
            <ellipse cx="16" cy="16" rx="14" ry="5.5" fill="none" stroke="#2bb6e6" strokeWidth="1.6" transform="rotate(-24 16 16)" />
            <circle cx="28.2" cy="11.4" r="1.6" fill="#e8edf5" />
          </svg>
          <span className="text-lg font-semibold tracking-tight">Kuiper</span>
        </div>
        <WalletMultiButton />
      </div>
    </header>
  );
}
