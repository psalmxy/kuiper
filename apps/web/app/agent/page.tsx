import { AgentChat } from "@/components/AgentChat";
import { Header } from "@/components/Header";

export const metadata = { title: "Kuiper Agent — DeFi on Solana, you approve every move" };

export default function AgentPage() {
  return (
    <>
      <Header />
      <main className="mx-auto flex max-w-[720px] flex-col gap-4 px-4 pt-8 pb-40">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent</h1>
          <p className="mt-1 text-sm text-dim">
            Ask for a swap, stake, loan or recurring buy. Kuiper finds the route, checks the tokens and simulates the trade, then hands you a ticket.
            Nothing moves until you approve it in your own wallet.
          </p>
        </div>
        <AgentChat />
      </main>
    </>
  );
}
