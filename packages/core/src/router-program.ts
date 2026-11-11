import { createHash } from "node:crypto";
import { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";

/** Default (placeholder) program id — replace with yours after `anchor keys sync && anchor deploy`. */
export const KUIPER_ROUTER_PROGRAM_ID = new PublicKey("W53zPEXxb3JQx8YQsSNCeJPHKskzFuMA7itqnzCaisn");
export const ROUTE_DISCRIMINATOR = createHash("sha256").update("global:route").digest().subarray(0, 8);
export const ROUTER_MAX_SLOTS = 6;
export const ROUTER_MAX_STEPS = 8;

/** Mirrors `kuiper_router::Step` (Borsh). */
export interface RouterStep {
  inputSlot: number;
  outputSlot: number;
  percent: number;
  accountsLen: number;
  amountOffset: number;
  data: Buffer;
}

export function encodeRouteArgs(inAmount: bigint, minOut: bigint, numSlots: number, steps: RouterStep[]): Buffer {
  const parts: Buffer[] = [ROUTE_DISCRIMINATOR];
  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  };
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  parts.push(u64(inAmount), u64(minOut), Buffer.from([numSlots]), u32(steps.length));
  for (const s of steps) {
    const head = Buffer.alloc(6);
    head.writeUInt8(s.inputSlot, 0);
    head.writeUInt8(s.outputSlot, 1);
    head.writeUInt8(s.percent, 2);
    head.writeUInt8(s.accountsLen, 3);
    head.writeUInt16LE(s.amountOffset, 4);
    parts.push(head, u32(s.data.length), s.data);
  }
  return Buffer.concat(parts);
}

export interface RouterLegIx {
  inputSlot: number;
  outputSlot: number;
  percent: number;
  amountOffset: number;
  /** The DEX swap instruction built for this leg (min-out 0; amount gets patched on-chain). */
  ix: TransactionInstruction;
}

/** Build the `route` instruction. remaining_accounts = slots, then per step [program, ...accounts]. */
export function buildRouterInstruction(a: {
  programId?: PublicKey;
  user: PublicKey;
  slots: PublicKey[];
  inAmount: bigint;
  minOut: bigint;
  legs: RouterLegIx[];
}): TransactionInstruction {
  if (a.slots.length < 2 || a.slots.length > ROUTER_MAX_SLOTS) throw new Error(`router supports 2-${ROUTER_MAX_SLOTS} slots`);
  if (a.legs.length === 0 || a.legs.length > ROUTER_MAX_STEPS) throw new Error(`router supports 1-${ROUTER_MAX_STEPS} steps`);
  const keys: AccountMeta[] = [{ pubkey: a.user, isSigner: true, isWritable: false }];
  for (const s of a.slots) keys.push({ pubkey: s, isSigner: false, isWritable: true });
  const steps: RouterStep[] = [];
  for (const l of a.legs) {
    keys.push({ pubkey: l.ix.programId, isSigner: false, isWritable: false });
    keys.push(...l.ix.keys);
    steps.push({
      inputSlot: l.inputSlot,
      outputSlot: l.outputSlot,
      percent: l.percent,
      accountsLen: l.ix.keys.length,
      amountOffset: l.amountOffset,
      data: Buffer.from(l.ix.data),
    });
  }
  return new TransactionInstruction({
    programId: a.programId ?? KUIPER_ROUTER_PROGRAM_ID,
    keys,
    data: encodeRouteArgs(a.inAmount, a.minOut, a.slots.length, steps),
  });
}
