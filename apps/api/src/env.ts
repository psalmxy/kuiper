import { z } from "zod";

const schema = z.object({
  RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  JUP_API_KEY: z.string().optional().default(""),
  FEE_WALLET: z.string().optional().default(""),
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(255).default(20),
  POOL_REFRESH_MS: z.coerce.number().int().min(250).default(2000),
  PORT: z.coerce.number().int().default(8787),
  CORS_ORIGIN: z.string().default("*"),
  /** Set once the Kuiper router program is deployed; enables multi-hop Kuiper routes. */
  KUIPER_ROUTER_PROGRAM_ID: z.string().optional().default(""),
  /** For the DeFi agent (/agent/chat). */
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  AGENT_MODEL: z.string().default("claude-sonnet-5-5"),
  /**
   * Helius Sender endpoint for fast landing. Empty string disables it (plain RPC submit).
   * Default: global HTTPS, SWQOS-only tier (0.000005 SOL min tip) with MEV protection.
   * On a server, a regional HTTP endpoint near you is faster, e.g. http://fra-sender.helius-rpc.com/fast?swqos_only=true&mev-protect=true
   */
  SENDER_URL: z.string().default("https://sender.helius-rpc.com/fast?swqos_only=true&mev-protect=true"),
  /** Tip added to every transaction sent via Sender. SWQOS-only minimum is 5000 lamports (0.000005 SOL). */
  SENDER_TIP_LAMPORTS: z.coerce.number().int().min(0).default(5_000),
});

export const env = schema.parse(process.env);
