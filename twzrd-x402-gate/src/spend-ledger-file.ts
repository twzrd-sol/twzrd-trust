/** Durable, cross-process spend ledger: v2 append-only JSONL + SHA-256 chain. */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createMemorySpendLedger, type SpendLedger } from "./policy-runtime.js";

type Event = "hold" | "hold_signed" | "commit" | "release";
type Row = { at: number; scope: string; micro: string; prev: string; v?: 2; type?: Event; hold_id?: string; pid?: number; hostname?: string; signed?: boolean; reference?: string; channel_id?: string; voucher_total_micro?: string };
type Hold = { id: string; scope: string; micro: bigint; at: number; pid: number; hostname: string; signed: boolean; channelId?: string; voucherTotal?: bigint };
type State = { ledger: ReturnType<typeof createMemorySpendLedger>; hash: string; holds: Map<string, Hold>; resolved: Set<string>; refs: Set<string>; channels: Map<string, bigint> };
const GENESIS = "genesis";
const LOCAL = hostname();
const sha256 = (line: string) => createHash("sha256").update(line).digest("hex");
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function unlocker(filePath: string, timeoutMs = 3_000): () => void {
  const lockPath = `${filePath}.lock`, start = Date.now();
  let sleepMs = 3;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, hostname: LOCAL, acquiredAt: Date.now() })); }
      finally { closeSync(fd); }
      return () => { try { unlinkSync(lockPath); } catch { /* best effort */ } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; hostname?: string; acquiredAt?: number };
        const old = Number.isFinite(lock.acquiredAt) && Date.now() - lock.acquiredAt! > 5_000;
        // Never break a remote host's lock on age alone. Same-host locks need
        // both age and ESRCH, so a slow process is not mistaken for a crash.
        if (old && lock.hostname === LOCAL && Number.isInteger(lock.pid) && !pidAlive(lock.pid!)) {
          try { unlinkSync(lockPath); } catch { /* another waiter won */ }
          continue;
        }
      } catch { /* malformed/partial lock is fail-safe until it can be inspected */ }
      if (Date.now() - start >= timeoutMs) throw new Error(`[twzrd-x402-gate] spend ledger lock timeout: ${lockPath}`);
      Atomics.wait(waitCell, 0, 0, sleepMs);
      sleepMs = Math.min(50, sleepMs * 2);
    }
  }
}

function replay(path: string): State {
  const ledger = createMemorySpendLedger(), holds = new Map<string, Hold>(), resolved = new Set<string>(), refs = new Set<string>(), channels = new Map<string, bigint>();
  let hash = GENESIS;
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let row: Row;
    try { row = JSON.parse(line) as Row; } catch { throw new Error(`[twzrd-x402-gate] spend ledger corrupt row: ${path}`); }
    if (row.prev !== hash || typeof row.scope !== "string" || typeof row.micro !== "string" || !Number.isFinite(row.at)) throw new Error(`[twzrd-x402-gate] spend ledger chain broken: ${path}`);
    const amount = BigInt(row.micro);
    if (amount < 0n) throw new Error(`[twzrd-x402-gate] spend ledger negative row: ${path}`);
    // Unversioned 0.27.0 rows are historical committed spend. Preserve the
    // original bytes as the chain input; only the interpreted state is upgraded.
    if (row.v !== 2) ledger.record(row.scope, amount, row.at);
    else {
      if (row.v !== 2 || !row.type || !row.hold_id) throw new Error(`[twzrd-x402-gate] spend ledger invalid v2 row: ${path}`);
      if (row.type === "hold" && !resolved.has(row.hold_id)) holds.set(row.hold_id, { id: row.hold_id, scope: row.scope, micro: amount, at: row.at, pid: row.pid ?? 0, hostname: row.hostname ?? "", signed: row.signed === true, channelId: row.channel_id, voucherTotal: row.voucher_total_micro === undefined ? undefined : BigInt(row.voucher_total_micro) });
      else if (row.type === "hold_signed" && !resolved.has(row.hold_id)) {
        const hold = holds.get(row.hold_id); if (hold) hold.signed = true;
      } else if ((row.type === "commit" || row.type === "release") && !resolved.has(row.hold_id)) {
        const hold = holds.get(row.hold_id); holds.delete(row.hold_id); resolved.add(row.hold_id);
        if (row.type === "commit") {
          ledger.record(row.scope, amount, row.at);
          if (row.reference) refs.add(row.reference);
          if (row.channel_id && row.voucher_total_micro !== undefined) {
            const total = BigInt(row.voucher_total_micro), prev = channels.get(row.channel_id) ?? 0n;
            if (total > prev) channels.set(row.channel_id, total);
          }
        }
        void hold;
      }
    }
    hash = sha256(line);
  }
  return { ledger, hash, holds, resolved, refs, channels };
}

export type FileSpendLedger = SpendLedger & {
  reserve(scope: string, amount: bigint, holdId: string, cap: bigint | undefined, windowMs: number, at: number): boolean;
  reserveChannel(scope: string, amount: bigint, holdId: string, cap: bigint | undefined, windowMs: number, at: number, channelId: string, voucherTotal: bigint): boolean;
  markSigned(holdId: string): boolean;
  commit(holdId: string, reference?: string, amount?: bigint, channelId?: string, voucherTotal?: bigint): boolean;
  release(holdId: string): boolean;
  commitSettlement(scope: string, amount: bigint, reference: string, at: number, channelId?: string, voucherTotal?: bigint): boolean;
  highestSpentMicroByChannel(channelId: string): bigint;
  highestVoucherMicroByChannel(channelId: string): bigint;
  settlementReferenceSeen(reference: string): boolean;
};

export const DEFAULT_SPEND_LEDGER_FILE = ".twzrd/spend-v2.jsonl";
const CROSS_HOST_HOLD_TIMEOUT_MS = 900_000;

export function createFileSpendLedger(filePath: string): FileSpendLedger {
  const path = resolve(filePath); mkdirSync(dirname(path), { recursive: true });
  // Fail closed at construction just as the 0.27.0 reader did.
  replay(path);
  const append = (state: State, type: Event, scope: string, micro: bigint, at: number, hold?: Hold, reference?: string, channelId?: string, voucherTotal?: bigint) => {
    const row: Row = { v: 2, type, hold_id: hold?.id ?? "", at, scope, micro: micro.toString(), prev: state.hash,
      ...(hold ? { pid: hold.pid, hostname: hold.hostname, signed: hold.signed, ...(hold.channelId ? { channel_id: hold.channelId } : {}), ...(hold.voucherTotal !== undefined ? { voucher_total_micro: hold.voucherTotal.toString() } : {}) } : {}),
      ...(reference ? { reference } : {}), ...(channelId ? { channel_id: channelId } : {}),
      ...(voucherTotal !== undefined ? { voucher_total_micro: voucherTotal.toString() } : {}) };
    if (!row.hold_id) throw new Error("v2 spend row requires hold_id");
    const line = JSON.stringify(row); appendFileSync(path, `${line}\n`, { mode: 0o600 }); state.hash = sha256(line);
  };
  const withState = <T>(fn: (state: State) => T): T => {
    const release = unlocker(path);
    try {
      const state = replay(path); // refresh every byte appended by other processes
      // Permanently resolve only dead local owners or stale remote owners.
      for (const hold of [...state.holds.values()]) {
        const deadLocal = hold.hostname === LOCAL && !pidAlive(hold.pid);
        const staleRemote = hold.hostname !== LOCAL && Date.now() - hold.at > CROSS_HOST_HOLD_TIMEOUT_MS;
        if (!deadLocal && !staleRemote) continue;
        if (state.resolved.has(hold.id)) continue;
        append(state, hold.signed ? "commit" : "release", hold.scope, hold.signed ? hold.micro : 0n, Date.now(), hold);
        state.holds.delete(hold.id); state.resolved.add(hold.id);
        if (hold.signed) {
          state.ledger.record(hold.scope, hold.micro, Date.now());
          if (hold.channelId && hold.voucherTotal !== undefined) {
            const previous = state.channels.get(hold.channelId) ?? 0n;
            if (hold.voucherTotal > previous) state.channels.set(hold.channelId, hold.voucherTotal);
          }
        }
      }
      return fn(state);
    } finally { release(); }
  };
  return {
    spentMicro(scope, windowMs, now) { return withState(s => {
      let total = s.ledger.spentMicro(scope, windowMs, now);
      for (const h of s.holds.values()) if (h.scope === scope && now - h.at <= windowMs) total += h.micro;
      return total;
    }); },
    firstSeen(scope) { return withState(s => s.ledger.firstSeen(scope)); },
    record(scope, amount, at) {
      if (amount < 0n) throw new RangeError("spend amount must not be negative");
      const id = `legacy-${process.pid}-${Date.now()}-${Math.random()}`;
      withState(s => { append(s, "commit", scope, amount, at, { id, scope, micro: amount, at, pid: process.pid, hostname: LOCAL, signed: true }); s.ledger.record(scope, amount, at); s.resolved.add(id); });
    },
    reserve(scope, amount, holdId, cap, windowMs, at) { return withState(s => {
      if (amount < 0n) throw new RangeError("reservation amount must not be negative");
      if (s.holds.has(holdId)) return true;
      if (s.resolved.has(holdId)) return false;
      let spent = s.ledger.spentMicro(scope, windowMs, at);
      for (const h of s.holds.values()) if (h.scope === scope && at - h.at <= windowMs) spent += h.micro;
      if (cap !== undefined && spent + amount > cap) return false;
      const hold: Hold = { id: holdId, scope, micro: amount, at, pid: process.pid, hostname: LOCAL, signed: false };
      append(s, "hold", scope, amount, at, hold); s.holds.set(holdId, hold); return true;
    }); },
    reserveChannel(scope, amount, holdId, cap, windowMs, at, channelId, voucherTotal) { return withState(s => {
      if (amount < 0n || voucherTotal < 0n) throw new RangeError("reservation amount must not be negative");
      if (s.holds.has(holdId)) return true;
      if (s.resolved.has(holdId)) return false;
      let spent = s.ledger.spentMicro(scope, windowMs, at);
      for (const h of s.holds.values()) if (h.scope === scope && at - h.at <= windowMs) spent += h.micro;
      if (cap !== undefined && spent + amount > cap) return false;
      const hold: Hold = { id: holdId, scope, micro: amount, at, pid: process.pid, hostname: LOCAL, signed: false, channelId, voucherTotal };
      append(s, "hold", scope, amount, at, hold); s.holds.set(holdId, hold); return true;
    }); },
    markSigned(holdId) { return withState(s => {
      const h = s.holds.get(holdId); if (!h || s.resolved.has(holdId) || h.signed) return false;
      h.signed = true; append(s, "hold_signed", h.scope, h.micro, Date.now(), h); return true;
    }); },
    commit(holdId, reference, amount, channelId, voucherTotal) { return withState(s => {
      const h = s.holds.get(holdId); if (!h || s.resolved.has(holdId)) return false;
      if (reference && s.refs.has(reference)) { append(s, "release", h.scope, 0n, Date.now(), h); s.holds.delete(holdId); s.resolved.add(holdId); return false; }
      let value = amount ?? h.micro;
      const boundChannel = channelId ?? h.channelId;
      const boundVoucherTotal = voucherTotal ?? h.voucherTotal;
      if (boundChannel && boundVoucherTotal !== undefined) {
        const high = s.channels.get(boundChannel) ?? 0n;
        value = boundVoucherTotal > high ? boundVoucherTotal - high : 0n;
      }
      if (value < 0n) throw new RangeError("spend amount must not be negative");
      append(s, "commit", h.scope, value, Date.now(), h, reference, boundChannel, boundVoucherTotal);
      s.holds.delete(holdId); s.resolved.add(holdId); s.ledger.record(h.scope, value, Date.now()); if (reference) s.refs.add(reference);
      if (boundChannel && boundVoucherTotal !== undefined) { const old = s.channels.get(boundChannel) ?? 0n; if (boundVoucherTotal > old) s.channels.set(boundChannel, boundVoucherTotal); }
      return true;
    }); },
    release(holdId) { return withState(s => {
      const h = s.holds.get(holdId); if (!h || s.resolved.has(holdId)) return false;
      append(s, "release", h.scope, 0n, Date.now(), h); s.holds.delete(holdId); s.resolved.add(holdId); return true;
    }); },
    commitSettlement(scope, amount, reference, at, channelId, voucherTotal) { return withState(s => {
      if (amount < 0n || (voucherTotal !== undefined && voucherTotal < 0n)) throw new RangeError("spend amount must not be negative");
      if (s.refs.has(reference)) return false;
      const id = `settlement-${process.pid}-${Date.now()}-${Math.random()}`;
      let value = amount;
      if (channelId && voucherTotal !== undefined) { const old = s.channels.get(channelId) ?? 0n; value = voucherTotal > old ? voucherTotal - old : 0n; }
      const h: Hold = { id, scope, micro: value, at, pid: process.pid, hostname: LOCAL, signed: true };
      append(s, "commit", scope, value, at, h, reference, channelId, voucherTotal); s.ledger.record(scope, value, at); s.refs.add(reference); s.resolved.add(id);
      if (channelId && voucherTotal !== undefined) { const old = s.channels.get(channelId) ?? 0n; if (voucherTotal > old) s.channels.set(channelId, voucherTotal); }
      return true;
    }); },
    highestSpentMicroByChannel(channelId) { return withState(s => s.channels.get(channelId) ?? 0n); },
    highestVoucherMicroByChannel(channelId) { return withState(s => {
      let high = s.channels.get(channelId) ?? 0n;
      for (const h of s.holds.values()) if (h.channelId === channelId && h.voucherTotal !== undefined && h.voucherTotal > high) high = h.voucherTotal;
      return high;
    }); },
    settlementReferenceSeen(reference) { return withState(s => s.refs.has(reference)); },
  };
}

const fileLedgers = new Map<string, FileSpendLedger>();
export function sharedFileSpendLedger(filePath: string): FileSpendLedger {
  const key = resolve(filePath); let ledger = fileLedgers.get(key);
  if (!ledger) { ledger = createFileSpendLedger(key); fileLedgers.set(key, ledger); }
  return ledger;
}
export function __resetSharedFileSpendLedgers(): void { fileLedgers.clear(); }

/** Convert token base units to micro-USD, rounding UP to avoid under-counting. */
export function tokenAmountToMicroUsdCeil(amount: bigint, decimals: number): bigint {
  if (amount < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError("invalid token amount or decimals");
  const d = 10n ** BigInt(decimals);
  return (amount * 1_000_000n + d - 1n) / d;
}
