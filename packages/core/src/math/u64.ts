export const U64_MAX = (1n << 64n) - 1n;

export const ceilDiv = (a: bigint, num: bigint, den: bigint): bigint => {
  if (den === 0n) throw new Error("division by zero");
  return (a * num + den - 1n) / den;
};

export const floorDiv = (a: bigint, num: bigint, den: bigint): bigint => {
  if (den === 0n) throw new Error("division by zero");
  return (a * num) / den;
};

export const readU64 = (buf: Buffer, offset: number): bigint => buf.readBigUInt64LE(offset);

export const u64Le = (v: bigint): Buffer => {
  if (v < 0n || v > U64_MAX) throw new Error(`u64 out of range: ${v}`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

/** SPL token account `amount` lives at byte 64 for both Token and Token-2022. */
export const tokenAccountAmount = (data: Buffer): bigint => data.readBigUInt64LE(64);

/** Apply slippage to an expected output: floor(out * (10_000 - bps) / 10_000). */
export const applySlippage = (out: bigint, slippageBps: number): bigint =>
  (out * BigInt(10_000 - slippageBps)) / 10_000n;
