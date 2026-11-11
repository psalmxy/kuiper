import { Keypair, type AccountInfo } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it } from "vitest";
import {
  POOL_STATE_DISCRIMINATOR,
  RAYDIUM_CPMM_PROGRAM_ID,
  RaydiumCpmmAmm,
  SWAP_BASE_INPUT_DISCRIMINATOR,
  cpmmSwapBaseInput,
} from "../src/adapters/raydium-cpmm.js";
import type { AccountMap } from "../src/types.js";

const k = () => Keypair.generate().publicKey;
const acct = (data: Buffer, owner = RAYDIUM_CPMM_PROGRAM_ID): AccountInfo<Buffer> => ({ data, owner, lamports: 1, executable: false, rentEpoch: 0 });

function fixture(opts: { reserve0: bigint; reserve1: bigint; tradeFeeRate: bigint; protocolFees0?: bigint; status?: number }) {
  const ids = { pool: k(), config: k(), vault0: k(), vault1: k(), mint0: k(), mint1: k(), obs: k() };
  const pool = Buffer.alloc(637);
  POOL_STATE_DISCRIMINATOR.copy(pool, 0);
  ids.config.toBuffer().copy(pool, 8);
  ids.vault0.toBuffer().copy(pool, 72);
  ids.vault1.toBuffer().copy(pool, 104);
  ids.mint0.toBuffer().copy(pool, 168);
  ids.mint1.toBuffer().copy(pool, 200);
  TOKEN_PROGRAM_ID.toBuffer().copy(pool, 232);
  TOKEN_PROGRAM_ID.toBuffer().copy(pool, 264);
  ids.obs.toBuffer().copy(pool, 296);
  pool.writeUInt8(opts.status ?? 0, 329);
  pool.writeBigUInt64LE(opts.protocolFees0 ?? 0n, 341);

  const config = Buffer.alloc(236);
  config.writeBigUInt64LE(opts.tradeFeeRate, 12);

  const tokenAcc = (amount: bigint) => {
    const b = Buffer.alloc(165);
    b.writeBigUInt64LE(amount, 64);
    return b;
  };
  const map: AccountMap = new Map([
    [ids.pool.toBase58(), acct(pool)],
    [ids.config.toBase58(), acct(config)],
    [ids.vault0.toBase58(), acct(tokenAcc(opts.reserve0 + (opts.protocolFees0 ?? 0n)), TOKEN_PROGRAM_ID)],
    [ids.vault1.toBase58(), acct(tokenAcc(opts.reserve1), TOKEN_PROGRAM_ID)],
  ]);
  const amm = new RaydiumCpmmAmm(ids.pool, acct(pool));
  amm.update(map);
  return { amm, ids };
}

describe("Raydium CPMM", () => {
  it("anchor discriminators match the deployed program", () => {
    expect(SWAP_BASE_INPUT_DISCRIMINATOR.toString("hex")).toBe("8fbe5adac41e33de");
    expect(POOL_STATE_DISCRIMINATOR.toString("hex")).toBe("f7ede3f5d7c3de46");
  });

  it("math matches the on-chain calculator (reference values computed independently)", () => {
    const base = { amountIn: 1_000_000n, inputReserve: 1_000_000_000n, outputReserve: 2_000_000_000n, tradeFeeRate: 2500n };
    expect(cpmmSwapBaseInput({ ...base, creatorFeeRate: 0n, creatorFeeOnInput: false })).toMatchObject({ amountOut: 1_993_011n, tradeFee: 2500n });
    expect(cpmmSwapBaseInput({ ...base, creatorFeeRate: 1000n, creatorFeeOnInput: true })).toMatchObject({ amountOut: 1_991_015n, tradeFee: 2500n, creatorFee: 1000n });
    expect(cpmmSwapBaseInput({ ...base, creatorFeeRate: 1000n, creatorFeeOnInput: false }).amountOut).toBe(1_991_017n);
  });

  it("decodes a pool, excludes accrued protocol fees from reserves, and quotes both directions", () => {
    const { amm, ids } = fixture({ reserve0: 1_000_000_000n, reserve1: 2_000_000_000n, tradeFeeRate: 2500n, protocolFees0: 5_000_000n });
    expect(amm.isActive()).toBe(true);
    expect(amm.reserves()).toEqual([1_000_000_000n, 2_000_000_000n]);
    expect(amm.quote({ inputMint: ids.mint0, outputMint: ids.mint1, amount: 1_000_000n }).outAmount).toBe(1_993_011n);
    const back = amm.quote({ inputMint: ids.mint1, outputMint: ids.mint0, amount: 2_000_000n });
    expect(back.outAmount).toBeGreaterThan(990_000n);
    expect(back.outAmount).toBeLessThan(1_000_000n);
  });

  it("is inactive when the swap status bit is set", () => {
    const { amm } = fixture({ reserve0: 1n << 30n, reserve1: 1n << 30n, tradeFeeRate: 2500n, status: 1 << 2 });
    expect(amm.isActive()).toBe(false);
  });

  it("builds swap_base_input with the program's 13-account layout", () => {
    const { amm, ids } = fixture({ reserve0: 1_000_000_000n, reserve1: 2_000_000_000n, tradeFeeRate: 2500n });
    const user = k();
    const [ix] = amm.swapInstructions({
      user,
      inputMint: ids.mint1,
      outputMint: ids.mint0,
      userSourceTokenAccount: k(),
      userDestinationTokenAccount: k(),
      inAmount: 5n,
      minOutAmount: 2n,
    });
    expect(ix!.programId.equals(RAYDIUM_CPMM_PROGRAM_ID)).toBe(true);
    expect(ix!.keys).toHaveLength(13);
    expect(ix!.keys[0]!.pubkey.equals(user) && ix!.keys[0]!.isSigner).toBe(true);
    expect(ix!.keys[6]!.pubkey.equals(ids.vault1)).toBe(true); // input vault for 1→0
    expect(ix!.keys[7]!.pubkey.equals(ids.vault0)).toBe(true);
    expect(ix!.keys[12]!.isWritable).toBe(true); // observation state
    expect(ix!.data.subarray(8, 16).readBigUInt64LE()).toBe(5n);
    expect(ix!.data.subarray(16, 24).readBigUInt64LE()).toBe(2n);
  });
});

