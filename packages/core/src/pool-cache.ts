import { PublicKey, type Connection } from "@solana/web3.js";
import { MeteoraDlmmAmm } from "./adapters/meteora-dlmm.js";
import { OrcaWhirlpoolAmm, makeWhirlpoolProgram } from "./adapters/orca-whirlpool.js";
import { RaydiumCpmmAmm } from "./adapters/raydium-cpmm.js";
import type { AccountMap, Amm, PoolConfig } from "./types.js";

const BATCH = 100; // getMultipleAccountsInfo limit

/**
 * In-memory liquidity snapshot — Kuiper's equivalent of the cache inside Jupiter's core engine.
 * v1 polls with batched getMultipleAccountsInfo. Phase 3 swaps this for a Yellowstone gRPC
 * account stream (what Jupiter runs), with no changes to adapters.
 */
export class PoolCache {
  amms: Amm[] = [];
  lastRefresh = 0;
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(
    private readonly connection: Connection,
    private readonly configs: PoolConfig[],
    private readonly log: (msg: string) => void = console.log,
  ) {}

  async init() {
    this.amms = [];
    const whirlpoolProgram = makeWhirlpoolProgram(this.connection);
    const keys = this.configs.map((c) => new PublicKey(c.address));
    const accounts = await this.fetch(keys);

    for (const cfg of this.configs) {
      const key = new PublicKey(cfg.address);
      try {
        if (cfg.kind === "meteora-dlmm") {
          this.amms.push(await MeteoraDlmmAmm.load(this.connection, key));
          continue;
        }
        const acc = accounts.get(cfg.address);
        if (!acc) throw new Error("account not found");
        this.amms.push(cfg.kind === "raydium-cpmm" ? new RaydiumCpmmAmm(key, acc) : new OrcaWhirlpoolAmm(key, acc, whirlpoolProgram));
      } catch (e) {
        this.log(`[pool-cache] skip ${cfg.kind} ${cfg.address}: ${(e as Error).message}`);
      }
    }
    // Two passes: dynamic adapters (Whirlpool tick arrays) only know their full account set after the first update.
    await this.refresh();
    await this.refresh();
    this.log(`[pool-cache] loaded ${this.amms.length}/${this.configs.length} pools, ${this.amms.filter((a) => a.isActive()).length} active`);
  }

  async refresh() {
    const keys = new Map<string, PublicKey>();
    for (const amm of this.amms) for (const k of amm.accountsToUpdate()) keys.set(k.toBase58(), k);
    const map = await this.fetch([...keys.values()]);
    await Promise.all(
      this.amms.map(async (amm) => {
        try {
          amm.update(map);
          if (amm.refresh) await amm.refresh(this.connection);
        } catch (e) {
          this.log(`[pool-cache] update failed ${amm.label} ${amm.key.toBase58()}: ${(e as Error).message}`);
        }
      }),
    );
    this.lastRefresh = Date.now();
  }

  start(intervalMs: number) {
    this.timer = setInterval(async () => {
      if (this.inFlight) return;
      this.inFlight = true;
      try {
        await this.refresh();
      } catch (e) {
        this.log(`[pool-cache] refresh error: ${(e as Error).message}`);
      } finally {
        this.inFlight = false;
      }
    }, intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  private async fetch(keys: PublicKey[]): Promise<AccountMap> {
    const map: AccountMap = new Map();
    const batches: PublicKey[][] = [];
    for (let i = 0; i < keys.length; i += BATCH) batches.push(keys.slice(i, i + BATCH));
    const results = await Promise.all(batches.map((b) => this.connection.getMultipleAccountsInfo(b, "confirmed")));
    batches.forEach((b, i) => b.forEach((k, j) => map.set(k.toBase58(), results[i]![j] ?? null)));
    return map;
  }
}
