# Kuiper

A Solana DEX aggregator built the way Jupiter is built — own routing engine, own DEX adapters, own fee — with Jupiter as a fallback so it's useful from day one.

![Kuiper swap UI](docs/ui.png)

Every quote races **Kuiper's router** against **Jupiter's `/swap/v2/build`** on the same net amount, and the user gets whichever pays more. As adapters and the router program mature, Kuiper wins more routes and Jupiter becomes optional.

## How it maps to Jupiter

| Jupiter | Kuiper | Where |
|---|---|---|
| `jupiter-amm-interface` `Amm` trait | `Amm` interface (`accountsToUpdate → update → quote → swapInstructions`, no network in `quote`) | `packages/core/src/types.ts` |
| DEX SDKs integrated into Metis | Raydium CPMM (native, ported from Raydium's Rust), Orca Whirlpool, Meteora DLMM | `packages/core/src/adapters/` |
| Core engine account cache + Geyser stream | `PoolCache` — batched `getMultipleAccountsInfo` polling (gRPC in phase 3) | `packages/core/src/pool-cache.ts` |
| Metis/Iris split routing (Bellman-Ford, golden-section / Brent split ratios) | Greedy marginal split across up to 3 pools + golden-section refinement | `packages/core/src/router.ts` |
| Swap API `/order` · `/build` | `GET /quote`, `POST /swap` (simulated, CU right-sized), `POST /send` | `apps/api/src/server.ts` |
| `jupiter-amm-test-kit` quote parity | `pnpm verify:pool` — simulates the real swap from a live holder and diffs vs our quote | `apps/api/scripts/verify-pool.ts` |
| Platform / referral fee | `PLATFORM_FEE_BPS` taken from input, applied identically to both routes | `packages/core/src/tx-builder.ts` |
| jup.ag | Next.js swap UI (wallet-standard, live quotes, route breakdown) | `apps/web` |

## Repo layout

```
packages/core   router, Amm interface, adapters, pool cache, tx builder  (+ vitest)
apps/api        Hono service: pool cache loop, Kuiper-vs-Jupiter quoting, tx building
apps/web        Next.js 16 swap UI
```

## Quick start

```bash
pnpm install
cp .env.example .env          # set RPC_URL (private RPC strongly recommended), JUP_API_KEY, FEE_WALLET
pnpm test                     # core unit tests
pnpm dev                      # api on :8787, web on :3000
```

Get a free Jupiter key at <https://portal.jup.ag>. Without it Kuiper runs router-only.

### Before you put real money through it

1. **Verify every pool you add** against mainnet: an exact match means the adapter math is right.
   ```bash
   pnpm verify:pool orca-whirlpool Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE 1000000000
   pnpm verify:pool meteora-dlmm 5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6 1000000000
   ```
2. **Add Raydium CPMM pools** — discover them on-chain, verify, then add to `apps/api/src/pools.json`:
   ```bash
   pnpm discover:cpmm So11111111111111111111111111111111111111112 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
   ```
3. **Create fee token accounts** for mints you want to earn on (fees on SPL inputs are skipped until the account exists, so users never pay your rent):
   ```bash
   FEE_KEYPAIR=~/.config/solana/fee.json pnpm fee-accounts EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
   ```
4. Do a small swap from a burner wallet.

## Design notes

- **Why splits only, no multi-hop (yet).** Chaining A→B→C atomically needs a router program that passes hop 1's *actual* output into hop 2 — that's what Jupiter's on-chain program does. Without it, multi-hop leaves dust or over-reverts. So v1 executes direct-pair routes (single or split, every leg with its own min-out, all in one tx), and multi-hop goes to Jupiter.
- **Why `/build`, not `/order`, for the fallback.** `/build` returns raw instructions we can compose with our fee instruction, and Jupiter charges no swap fee on it. `/order` transactions can't be modified.
- **Fair comparison.** The platform fee is deducted *before* quoting, and both engines quote the same net amount.
- **Safety defaults.** Paused/not-yet-open CPMM pools and Token-2022 CPMM pools are skipped (transfer-fee math not implemented). Every swap is simulated server-side before the user is asked to sign.

## Roadmap

- [x] **Phase 1 — Hybrid aggregator.** Adapters (CPMM, Whirlpool, DLMM), split router, Jupiter fallback, fee, UI.
- [ ] **Phase 2 — Kuiper router program (Anchor).** `route` instruction that CPIs each hop with the real intermediate amount and enforces a single final `min_out`. Unlocks multi-hop + mixed split/hop routes, and lets other programs CPI into Kuiper.
- [ ] **Phase 3 — Streaming state.** Yellowstone gRPC account subscriptions into `PoolCache`; DLMM adapter moved onto the batched `AccountMap` path.
- [ ] **Phase 4 — Graph router.** Token graph over all pools, top-k paths (modified Bellman-Ford / k-shortest-paths on −log(rate)), then split optimisation across paths.
- [ ] **Phase 5 — More venues.** Raydium AMM v4 & CLMM, pump.swap, Meteora DAMM v2, Phoenix/Manifest order books; Token-2022 transfer fees.
- [ ] **Phase 6 — Execution.** Jito bundles / Jupiter `/tx/v1/submit` landing, address lookup tables for Kuiper routes, gasless via integrator payer.
- [ ] **Phase 7 — Products.** Limit orders, DCA, referral program, token list + prices.

## License

MIT
