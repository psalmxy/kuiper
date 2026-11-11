/** "1.5" + 6 decimals → 1500000n. Returns null for invalid input. */
export function toBaseUnits(value: string, decimals: number): bigint | null {
  const v = value.trim();
  if (!/^\d*\.?\d*$/.test(v) || v === "" || v === ".") return null;
  const [whole = "0", frac = ""] = v.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** 1500000n + 6 decimals → "1.5" (trimmed, max `maxFrac` fraction digits). */
export function fromBaseUnits(amount: bigint | string, decimals: number, maxFrac = 6): string {
  const a = typeof amount === "string" ? BigInt(amount) : amount;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
}

export const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
