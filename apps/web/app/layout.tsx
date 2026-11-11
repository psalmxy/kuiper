import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Kuiper — Solana swap aggregator",
  description: "Best-price swaps on Solana. Kuiper routes across Raydium, Orca and Meteora, and falls back to Jupiter when that's better.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
