import { Header } from "@/components/Header";
import { SwapCard } from "@/components/SwapCard";

export default function Home() {
  return (
    <>
      <Header />
      <main className="mx-auto flex max-w-[480px] flex-col gap-6 px-4 pt-10 pb-24">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Swap</h1>
          <p className="mt-1 text-sm text-dim">Routes across Raydium, Orca and Meteora — falls back to Jupiter when it&apos;s better.</p>
        </div>
        <SwapCard />
      </main>
    </>
  );
}
