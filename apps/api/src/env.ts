import { z } from "zod";

const schema = z.object({
  RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  JUP_API_KEY: z.string().optional().default(""),
  FEE_WALLET: z.string().optional().default(""),
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(255).default(20),
  POOL_REFRESH_MS: z.coerce.number().int().min(250).default(2000),
  PORT: z.coerce.number().int().default(8787),
  CORS_ORIGIN: z.string().default("*"),
});

export const env = schema.parse(process.env);
