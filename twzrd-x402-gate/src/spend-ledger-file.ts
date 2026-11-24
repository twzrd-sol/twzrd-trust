/**
 * Durable, cross-process spend ledger: v2 append-only JSONL + SHA-256 chain.
 *
 * Every row commits to the SHA-256 of the line before it, so an edited,
 * dropped or reordered row breaks the chain and the file is refused: a
 * damaged spend record is never read as "nothing spent".
 *
 * Concurrency. Writes run under `<file>.lock`, held for one synchronous
 * replay + append and never across network work.
 * - The hold API (`reserveAsync` ... `commitSettlementAsync`) waits for the lock
 *   with timer backoff, so a busy lock never blocks the event loop, and
 *   rejects after 3 s.
 * - The synchronous `SpendLedger` methods never wait. `spentMicro` and
 *   `firstSeen` (and the channel/reference reads) replay a lock-free snapshot of
 *   complete rows (an unterminated last line counts as an append in progress
 *   only while the lock is held; otherwise the read refuses). `record` (it must
 *   stay synchronous for policy-runtime) tries the lock once: free, it appends to
 *   the chain as before; held by another process, it appends the row to this
 *   writer's pending journal (`<file>.pending.<host>.<pid>.<thread>`) and returns.
 *   Every read counts journal rows the chain does not hold yet, so the spend is
 *   visible at once, in every process. The journal is folded into the chain by a
 *   background flush on timers (`flushPending`), or by the next locked write of
 *   this writer; a dead writer's journal by the next locked write of any writer.
 *   Within one process the lock never contends, so with one process per file, as
 *   in 0.27.0, `record` never journals.
 * - Across processes, only the hold API checks a cap and holds the amount in
 *   one locked step. A synchronous `spentMicro` check followed by `record` is
 *   atomic within one process, not across processes.
 *
 * Cost. Every locked write and every snapshot read re-reads and re-hashes the
 * whole file: time linear in the number of rows. There is no compaction; point
 * a fresh `spendLedgerFile` when a file grows large (only the last window of
 * rows matters to a cap).
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { threadId } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { createMemorySpendLedger, type SpendLedger } from "./policy-runtime.js";

type Event = "hold" | "hold_signed" | "commit" | "release";
type Row = { at: number; scope: string; micro: string; prev: string; v?: 2; type?: Event; hold_id?: string; hold_micro?: string; pid?: number; hostname?: string; signed?: boolean; reference?: string; channel_id?: string; voucher_total_micro?: string };
type Hold = { id: string; scope: string; micro: bigint; at: number; pid: number; hostname: string; signed: boolean; channelId?: string; voucherTotal?: bigint };
type State = { ledger: ReturnType<typeof createMemorySpendLedger>; hash: string; holds: Map<string, Hold>; resolved: Set<string>; refs: Set<string>; channels: Map<string, bigint>; torn: boolean };
const GENESIS = "genesis";

/**
 * Where a pid can be checked. A pid means something only inside one PID
 * namespace and one boot, so the identity is the hostname plus, on Linux, the
 * PID namespace and the boot id. Containers that share a hostname but not a PID
 * namespace (host networking) then treat each other as remote hosts, whose
 * locks and holds go stale by age, never by a pid check that would read a live
 * peer as dead. A lock or hold left before a reboot is judged the same way, so
 * a pid reused after the reboot cannot keep it alive.
 */
function ownerIdentity(): string {
  let id = hostname();
  try { id += `/pidns:${readlinkSync("/proc/self/ns/pid").replace(/\D/g, "")}`; } catch { /* not Linux */ }
  try { id += `/boot:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().slice(0, 8)}`; } catch { /* not Linux */ }
  return id;
}
/** Written as `hostname` in locks and rows. */
const LOCAL = ownerIdentity();
const sha256 = (line: string) => createHash("sha256").update(line).digest("hex");

/** A same-host lock this old whose pid is gone, or an unreadable lock file this old, is stale. */
const LOCK_STALE_MS = 5_000;
/**
 * A remote owner's pid cannot be checked: its lock is stale only after this
 * long (holds last milliseconds). Judged on the remote owner's own clock, so
 * hosts sharing one file must keep their clocks in sync.
 */
const CROSS_HOST_LOCK_STALE_MS = 900_000;
/** How long the async hold API waits for the lock before rejecting. */
const LOCK_WAIT_MS = 3_000;
/** A remote owner's unresolved hold is resolved for it after this long. */
const CROSS_HOST_HOLD_TIMEOUT_MS = 900_000;
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/* ------------------------------------------------------------------ */
/* <file>.lock                                                          */
/* ------------------------------------------------------------------ */

type LockRecord = { pid: number; hostname: string; acquiredAt: number; token?: string };
/** A lock file as one waiter saw it. `identity` names this exact lock (its token, else its inode and stat). */
type LockView = { record: LockRecord | null; identity: string; mtimeMs: number };

function readLock(lockPath: string): LockView | null {
  let raw: string, st: ReturnType<typeof statSync>;
  try { st = statSync(lockPath); raw = readFileSync(lockPath, "utf8"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  let record: LockRecord | null = null;
  try {
    const p = JSON.parse(raw) as Partial<LockRecord> | null;
    if (p && typeof p === "object" && Number.isInteger(p.pid) && typeof p.hostname === "string" && Number.isFinite(p.acquiredAt)) record = p as LockRecord;
  } catch { /* unreadable: judged by file age alone */ }
  const identity = record?.token ? `token:${record.token}` : `file:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  return { record, identity, mtimeMs: st.mtimeMs };
}

function lockIsStale(view: LockView): boolean {
  const now = Date.now(), r = view.record;
  // Locks this module writes are published whole, so an unreadable one is a
  // write interrupted by a crash (an older writer, or a filesystem without
  // hard links). Nothing holds a lock for seconds, so age alone settles it.
  if (!r) return now - view.mtimeMs > LOCK_STALE_MS;
  if (r.hostname === LOCAL) return now - r.acquiredAt > LOCK_STALE_MS && !pidAlive(r.pid);
  return now - r.acquiredAt > CROSS_HOST_LOCK_STALE_MS;
}

/** O_EXCL create for filesystems without hard links. A crash mid-write leaves an unreadable lock, which goes stale by age. */
function publishLockDirect(lockPath: string, record: LockRecord): boolean {
  let fd: number;
  try { fd = openSync(lockPath, "wx", 0o600); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; throw err; }
  try { writeSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
  return true;
}

/** Create the lock with its whole record in one step: a fully written temp file, hard-linked into place. */
function publishLock(lockPath: string, record: LockRecord): boolean {
  const tempPath = `${lockPath}.${record.pid}.${record.token}.tmp`;
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify(record));
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    linkSync(tempPath, lockPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS") return publishLockDirect(lockPath, record);
    throw err;
  } finally {
    try { unlinkSync(tempPath); } catch { /* the hard link, if made, is the lock */ }
  }
}

/**
 * Remove a lock this waiter judged stale. Removal is serialized by the
 * `<file>.lock.reaper` directory, and its holder re-reads the lock and removes
 * it only if it is still the very lock judged stale. So two waiters can never
 * each remove a lock and both believe they hold the file: the second one finds
 * the first one's fresh lock, which is not stale. Returns false while another
 * waiter holds the reaper.
 */
function reapStaleLock(lockPath: string, seen: LockView): boolean {
  const reaperPath = `${lockPath}.reaper`;
  try { mkdirSync(reaperPath, 0o700); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; throw err; }
  try {
    const now = readLock(lockPath);
    if (now && now.identity === seen.identity && lockIsStale(now)) {
      try { unlinkSync(lockPath); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    }
    return true;
  } finally {
    try { rmdirSync(reaperPath); } catch { /* only a crash right here leaves it; see lockError */ }
  }
}

/**
 * Only the owner removes its own lock, and no other process may remove a lock
 * that is not stale (a same-host lock of a live pid never is), so release needs
 * no mutex and cannot be lost to a waiter that is reaping.
 */
function releaseLock(lockPath: string, token: string): void {
  try { if (readLock(lockPath)?.record?.token === token) unlinkSync(lockPath); }
  catch { /* left behind, it goes stale when this process exits */ }
}

/** One attempt that never waits. Returns the release function, or undefined while another owner holds the lock. */
function tryLock(lockPath: string): (() => void) | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record: LockRecord = { pid: process.pid, hostname: LOCAL, acquiredAt: Date.now(), token: randomUUID() };
    if (publishLock(lockPath, record)) return () => releaseLock(lockPath, record.token!);
    const seen = readLock(lockPath);
    if (seen === null) continue; // released between the attempt and the read
    if (!lockIsStale(seen) || !reapStaleLock(lockPath, seen)) return undefined;
  }
  return undefined;
}

function lockError(lockPath: string): Error {
  let hint = "";
  try {
    if (Date.now() - statSync(`${lockPath}.reaper`).mtimeMs > LOCK_STALE_MS) {
      hint = `; stale-lock recovery is blocked by ${lockPath}.reaper, left by a crashed process: remove it only when no process is using this ledger`;
    }
  } catch { /* no reaper left behind */ }
  try {
    const held = readLock(lockPath)?.record;
    // Nothing holds this lock for a minute. A same-host owner that old whose pid
    // is alive is most likely a reused pid (the owner died inside the lock).
    if (held && held.hostname === LOCAL && Date.now() - held.acquiredAt > 60_000) {
      hint += `; held by pid ${held.pid} since ${new Date(held.acquiredAt).toISOString()}: if that process is not using this ledger, remove the lock`;
    }
  } catch { /* unreadable: nothing to add */ }
  return new Error(`[twzrd-x402-gate] spend ledger lock timeout: ${lockPath}${hint}`);
}

const nextWait = (waitMs: number) => Math.min(40, waitMs * 2);
const jitter = (waitMs: number) => waitMs + Math.floor(Math.random() * waitMs);

/*
 * Every locked step takes the lock, runs `fn`, and releases it in one
 * synchronous stretch, so no other task in this process (not even a microtask)
 * ever finds this process's own lock held: within one process the lock never
 * contends. Nothing ever sleeps the thread waiting for it.
 */

/** Runner for the hold API: waits on timers, so the event loop keeps running, and rejects after the timeout. */
async function runLocked<T>(lockPath: string, fn: () => T, timeoutMs = LOCK_WAIT_MS): Promise<T> {
  const start = Date.now();
  let waitMs = 2;
  for (;;) {
    const release = tryLock(lockPath);
    if (release) { try { return fn(); } finally { release(); } }
    if (Date.now() - start >= timeoutMs) throw lockError(lockPath);
    await pause(jitter(waitMs));
    waitMs = nextWait(waitMs);
  }
}

/* ------------------------------------------------------------------ */
/* Replay                                                               */
/* ------------------------------------------------------------------ */

function amountOf(value: string, path: string): bigint {
  let amount: bigint;
  try { amount = BigInt(value); } catch { throw new Error(`[twzrd-x402-gate] spend ledger corrupt row: ${path}`); }
  if (amount < 0n) throw new Error(`[twzrd-x402-gate] spend ledger negative row: ${path}`);
  return amount;
}

/**
 * Rebuild state from complete rows. A last line without its newline is a row
 * still being appended (or a crashed append): a lock-free reader leaves it out;
 * a writer under the lock refuses the file rather than chain onto it.
 */
function replay(path: string, tornTail: "ignore" | "refuse"): State {
  const ledger = createMemorySpendLedger(), holds = new Map<string, Hold>(), resolved = new Set<string>(), refs = new Set<string>(), channels = new Map<string, bigint>();
  let hash = GENESIS;
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const end = raw.lastIndexOf("\n") + 1;
  const torn = end < raw.length;
  if (torn && tornTail === "refuse") throw new Error(`[twzrd-x402-gate] spend ledger corrupt row (unterminated last line): ${path}`);
  for (const line of raw.slice(0, end).split("\n")) {
    if (!line) continue;
    let row: Row;
    try { row = JSON.parse(line) as Row; } catch { throw new Error(`[twzrd-x402-gate] spend ledger corrupt row: ${path}`); }
    if (!row || typeof row !== "object" || row.prev !== hash || typeof row.scope !== "string" || typeof row.micro !== "string" || !Number.isFinite(row.at)) throw new Error(`[twzrd-x402-gate] spend ledger chain broken: ${path}`);
    const amount = amountOf(row.micro, path);
    // Unversioned 0.27.0 rows are historical committed spend. Preserve the
    // original bytes as the chain input; only the interpreted state is upgraded.
    if (row.v !== 2) ledger.record(row.scope, amount, row.at);
    else {
      if (!row.type || !row.hold_id) throw new Error(`[twzrd-x402-gate] spend ledger invalid v2 row: ${path}`);
      if (row.type === "hold" && !resolved.has(row.hold_id)) {
        // The hold amount is in hold_micro; rows written before that field carried it in micro.
        const held = row.hold_micro === undefined ? amount : amountOf(row.hold_micro, path);
        holds.set(row.hold_id, { id: row.hold_id, scope: row.scope, micro: held, at: row.at, pid: row.pid ?? 0, hostname: row.hostname ?? "", signed: row.signed === true, channelId: row.channel_id, voucherTotal: row.voucher_total_micro === undefined ? undefined : amountOf(row.voucher_total_micro, path) });
      } else if (row.type === "hold_signed" && !resolved.has(row.hold_id)) {
        const hold = holds.get(row.hold_id); if (hold) hold.signed = true;
      } else if ((row.type === "commit" || row.type === "release") && !resolved.has(row.hold_id)) {
        holds.delete(row.hold_id); resolved.add(row.hold_id);
        if (row.type === "commit") {
          ledger.record(row.scope, amount, row.at);
          if (row.reference) refs.add(row.reference);
          if (row.channel_id && row.voucher_total_micro !== undefined) raiseChannel({ channels }, row.channel_id, amountOf(row.voucher_total_micro, path));
        }
      }
    }
    hash = sha256(line);
  }
  return { ledger, hash, holds, resolved, refs, channels, torn };
}

function raiseChannel(state: Pick<State, "channels">, channelId: string, total: bigint): void {
  const previous = state.channels.get(channelId) ?? 0n;
  if (total > previous) state.channels.set(channelId, total);
}

/**
 * Resolve holds whose owner can never resolve them: a dead same-host pid, or a
 * remote owner silent past the timeout. A signed hold may have paid, so it is
 * committed; an unsigned one is released. `write` makes that durable (under the
 * lock); without it the resolution is applied to this snapshot only.
 */
function resolveOrphans(state: State, write?: (hold: Hold, at: number, value: bigint) => void): void {
  for (const hold of [...state.holds.values()]) {
    const at = Date.now();
    const deadLocal = hold.hostname === LOCAL && !pidAlive(hold.pid);
    const staleRemote = hold.hostname !== LOCAL && at - hold.at > CROSS_HOST_HOLD_TIMEOUT_MS;
    if (!deadLocal && !staleRemote) continue;
    // As commit() would: a session voucher counts only what it adds above the
    // channel's committed high-water, not the delta it held from an older one.
    let value = hold.signed ? hold.micro : 0n;
    if (hold.signed && hold.channelId && hold.voucherTotal !== undefined) {
      const high = state.channels.get(hold.channelId) ?? 0n;
      value = hold.voucherTotal > high ? hold.voucherTotal - high : 0n;
    }
    write?.(hold, at, value);
    state.holds.delete(hold.id); state.resolved.add(hold.id);
    if (hold.signed) {
      state.ledger.record(hold.scope, value, at);
      if (hold.channelId && hold.voucherTotal !== undefined) raiseChannel(state, hold.channelId, hold.voucherTotal);
    }
  }
}

function heldAndSpent(s: State, scope: string, windowMs: number, now: number): bigint {
  let total = s.ledger.spentMicro(scope, windowMs, now);
  for (const h of s.holds.values()) if (h.scope === scope && now - h.at <= windowMs) total += h.micro;
  return total;
}

/* ------------------------------------------------------------------ */
/* Pending journals                                                     */
/* ------------------------------------------------------------------ */

/** A committed spend a contended synchronous `record` wrote outside the chain. */
type PendingRow = { id: string; scope: string; micro: string; at: number; pid: number; hostname: string };
type PendingFile = { file: string; rows: PendingRow[]; own: boolean; dead: boolean };

/** Host identity tag in journal names: a pid in a name is judged only by the host that wrote it. */
const PENDING_TAG = sha256(LOCAL).slice(0, 16);
const pendingPrefix = (path: string) => `${basename(path)}.pending.`;
/** One journal per writer (host, pid, thread): nothing else ever appends to it. */
const ownPendingPath = (path: string) => `${path}.pending.${PENDING_TAG}.${process.pid}.${threadId}`;

/**
 * Every journal of this ledger, oldest name first. A writer is dead when its
 * pid is gone on this host, or (another host) when its journal is older than
 * the cross-host hold timeout. A last line without its newline is an append in
 * progress from a live writer (left out) and a crashed one from a dead writer
 * (refused, as the chain refuses one).
 */
function readPending(path: string): PendingFile[] {
  const dir = dirname(path), prefix = pendingPrefix(path), own = ownPendingPath(path);
  let names: string[];
  try { names = readdirSync(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
  const out: PendingFile[] = [];
  for (const name of names.filter(n => n.startsWith(prefix)).sort()) {
    const file = join(dir, name);
    let raw: string, mtimeMs: number;
    try { raw = readFileSync(file, "utf8"); mtimeMs = statSync(file).mtimeMs; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; throw err; } // merged meanwhile
    const [tag, pidText] = name.slice(prefix.length).split(".");
    const pid = Number(pidText);
    const dead = tag === PENDING_TAG ? !(Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid)) : Date.now() - mtimeMs > CROSS_HOST_HOLD_TIMEOUT_MS;
    const end = raw.lastIndexOf("\n") + 1;
    if (end < raw.length && dead) throw new Error(`[twzrd-x402-gate] spend ledger pending journal corrupt row (unterminated last line): ${file}`);
    const rows: PendingRow[] = [];
    for (const line of raw.slice(0, end).split("\n")) {
      if (!line) continue;
      let row: PendingRow;
      try { row = JSON.parse(line) as PendingRow; } catch { throw new Error(`[twzrd-x402-gate] spend ledger pending journal corrupt row: ${file}`); }
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id || typeof row.scope !== "string" || typeof row.micro !== "string" || !Number.isFinite(row.at)) {
        throw new Error(`[twzrd-x402-gate] spend ledger pending journal corrupt row: ${file}`);
      }
      amountOf(row.micro, file);
      rows.push(row);
    }
    out.push({ file, rows, own: file === own, dead });
  }
  return out;
}

/** Count the journal rows the chain does not hold yet (by hold id, so a merged row is never counted twice). */
function countPending(state: State, files: PendingFile[]): void {
  const seen = new Set<string>();
  for (const f of files) for (const row of f.rows) {
    if (state.resolved.has(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    state.ledger.record(row.scope, BigInt(row.micro), row.at);
  }
}

/** Ledgers with rows still journaled: each folds once more, without waiting, as its thread or process exits. */
const exitFolds = new Set<() => void>();
let exitHooked = false;
function foldAtExit(fold: () => void): void {
  exitFolds.add(fold);
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", () => {
    for (const f of exitFolds) { try { f(); } catch { /* the journal stays on disk, counted, for the next writer */ } }
  });
}

/** A pause; unref'd for the background flush (it never holds the process open), ref'd when a caller awaits flushPending(). */
const pauseFor = (ms: number, ref: boolean) => new Promise<void>((done) => { const t = setTimeout(done, ms); if (!ref) (t as { unref?: () => void }).unref?.(); });
/** How long a background flush keeps trying before it leaves the journal to the next locked write. */
const FLUSH_GIVE_UP_MS = 30_000;

/* ------------------------------------------------------------------ */
/* Ledger                                                               */
/* ------------------------------------------------------------------ */

export type FileSpendLedger = SpendLedger & {
  /** Lock-free snapshot reads. */
  highestSpentMicroByChannel(channelId: string): bigint;
  highestVoucherMicroByChannel(channelId: string): bigint;
  settlementReferenceSeen(reference: string): boolean;
  /**
   * Fold this writer's pending journal (rows a contended `record` wrote) into
   * the chain. Retries the lock on timers that keep the process alive until it
   * answers (the automatic background flush never does); resolves true once nothing of this
   * writer is pending, false if the lock stayed busy for 30 s (the rows stay
   * journaled, counted by every read, and merged by the next locked write).
   */
  flushPending(): Promise<boolean>;
  /**
   * Writes. Each waits for the file lock with timer backoff (the event loop
   * keeps running) and rejects if the lock is not free within 3 s.
   */
  reserveAsync(scope: string, amount: bigint, holdId: string, cap: bigint | undefined, windowMs: number, at: number): Promise<boolean>;
  reserveChannelAsync(scope: string, amount: bigint, holdId: string, cap: bigint | undefined, windowMs: number, at: number, channelId: string, voucherTotal: bigint): Promise<boolean>;
  markSignedAsync(holdId: string): Promise<boolean>;
  commitAsync(holdId: string, reference?: string, amount?: bigint, channelId?: string, voucherTotal?: bigint): Promise<boolean>;
  releaseAsync(holdId: string): Promise<boolean>;
  commitSettlementAsync(scope: string, amount: bigint, reference: string, at: number, channelId?: string, voucherTotal?: bigint): Promise<boolean>;
};

export const DEFAULT_SPEND_LEDGER_FILE = ".twzrd/spend-v2.jsonl";

export function createFileSpendLedger(filePath: string): FileSpendLedger {
  const path = resolve(filePath); mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  // Fail closed at construction just as the 0.27.0 reader did. Lock-free, so a
  // writer in another process never makes construction fail.
  replay(path, "ignore");

  const append = (state: State, type: Event, scope: string, micro: bigint, at: number, hold: Hold, reference?: string, channelId?: string, voucherTotal?: bigint) => {
    // Only commit rows carry spend in `micro`. A hold's amount is in hold_micro, so a
    // 0.27.0 reader (which sums `micro` over every row) counts each commit once
    // and never counts a hold, whether it was later committed or released.
    const holdRow = type === "hold" || type === "hold_signed";
    const row: Row = { v: 2, type, hold_id: hold.id, at, scope, micro: holdRow ? "0" : micro.toString(), ...(holdRow ? { hold_micro: micro.toString() } : {}), prev: state.hash,
      pid: hold.pid, hostname: hold.hostname, signed: hold.signed,
      ...(hold.channelId ? { channel_id: hold.channelId } : {}), ...(hold.voucherTotal !== undefined ? { voucher_total_micro: hold.voucherTotal.toString() } : {}),
      ...(reference ? { reference } : {}), ...(channelId ? { channel_id: channelId } : {}),
      ...(voucherTotal !== undefined ? { voucher_total_micro: voucherTotal.toString() } : {}) };
    if (!row.hold_id) throw new Error("v2 spend row requires hold_id");
    const line = JSON.stringify(row); appendFileSync(path, `${line}\n`, { mode: 0o600 }); state.hash = sha256(line);
  };
  const settleOrphans = (state: State) => resolveOrphans(state, (hold, at, value) => append(state, hold.signed ? "commit" : "release", hold.scope, value, at, hold));
  const ownPending = ownPendingPath(path);
  /**
   * Under the lock: fold this writer's journal and every dead writer's journal
   * into the chain and remove them; count a live writer's rows (its owner folds
   * them). A crash between the append and the removal leaves rows the chain
   * already holds: they are skipped by hold id.
   */
  const mergePending = (state: State) => {
    const seen = new Set<string>();
    for (const f of readPending(path)) {
      const fold = f.own || f.dead;
      for (const row of f.rows) {
        if (state.resolved.has(row.id) || seen.has(row.id)) continue;
        seen.add(row.id);
        const micro = BigInt(row.micro);
        if (fold) {
          append(state, "commit", row.scope, micro, row.at, { id: row.id, scope: row.scope, micro, at: row.at, pid: row.pid, hostname: row.hostname, signed: true });
          state.resolved.add(row.id);
        }
        state.ledger.record(row.scope, micro, row.at);
      }
      if (fold) { try { unlinkSync(f.file); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; } }
    }
  };
  const snapshot = (): State => {
    // Journals before the chain: a row merged in between is then found in the
    // chain (and skipped in the journal), never in neither.
    const pending = readPending(path);
    let state = replay(path, "ignore");
    // An unterminated last line with no lock held is not an append in
    // progress: it is a crashed one. Look once more (the writer may have just
    // finished), then refuse instead of reading less spent than was written.
    if (state.torn && !existsSync(lockPath)) {
      state = replay(path, "ignore");
      if (state.torn && !existsSync(lockPath)) throw new Error(`[twzrd-x402-gate] spend ledger corrupt row (unterminated last line): ${path}`);
    }
    countPending(state, pending);
    resolveOrphans(state);
    return state;
  };
  const locked = <T>(fn: (state: State) => T) => (): T => {
    const state = replay(path, "refuse"); // every byte other processes appended
    mergePending(state);
    settleOrphans(state);
    return fn(state);
  };
  // The lock is never held across an await: not across network work, and not across another task's turn.
  const withState = <T>(fn: (state: State) => T): Promise<T> => runLocked(lockPath, locked(fn));

  const reserve = (s: State, scope: string, amount: bigint, holdId: string, cap: bigint | undefined, windowMs: number, at: number, channelId?: string, voucherTotal?: bigint): boolean => {
    if (amount < 0n || (voucherTotal !== undefined && voucherTotal < 0n)) throw new RangeError("reservation amount must not be negative");
    if (s.holds.has(holdId)) return true;
    if (s.resolved.has(holdId)) return false;
    if (cap !== undefined && heldAndSpent(s, scope, windowMs, at) + amount > cap) return false;
    const hold: Hold = { id: holdId, scope, micro: amount, at, pid: process.pid, hostname: LOCAL, signed: false, ...(channelId !== undefined ? { channelId, voucherTotal } : {}) };
    append(s, "hold", scope, amount, at, hold); s.holds.set(holdId, hold); return true;
  };
  const markSigned = (s: State, holdId: string): boolean => {
    const h = s.holds.get(holdId); if (!h || s.resolved.has(holdId) || h.signed) return false;
    h.signed = true; append(s, "hold_signed", h.scope, h.micro, Date.now(), h); return true;
  };
  const release = (s: State, holdId: string): boolean => {
    const h = s.holds.get(holdId); if (!h || s.resolved.has(holdId)) return false;
    append(s, "release", h.scope, 0n, Date.now(), h); s.holds.delete(holdId); s.resolved.add(holdId); return true;
  };
  const commit = (s: State, holdId: string, reference?: string, amount?: bigint, channelId?: string, voucherTotal?: bigint): boolean => {
    const h = s.holds.get(holdId); if (!h || s.resolved.has(holdId)) return false;
    // A settlement reference already counted is not counted twice.
    if (reference && s.refs.has(reference)) { release(s, holdId); return false; }
    let value = amount ?? h.micro;
    const boundChannel = channelId ?? h.channelId;
    const boundVoucherTotal = voucherTotal ?? h.voucherTotal;
    if (boundChannel && boundVoucherTotal !== undefined) {
      const high = s.channels.get(boundChannel) ?? 0n;
      value = boundVoucherTotal > high ? boundVoucherTotal - high : 0n;
    }
    if (value < 0n) throw new RangeError("spend amount must not be negative");
    const at = Date.now();
    append(s, "commit", h.scope, value, at, h, reference, boundChannel, boundVoucherTotal);
    s.holds.delete(holdId); s.resolved.add(holdId); s.ledger.record(h.scope, value, at); if (reference) s.refs.add(reference);
    if (boundChannel && boundVoucherTotal !== undefined) raiseChannel(s, boundChannel, boundVoucherTotal);
    return true;
  };
  const commitSettlement = (s: State, scope: string, amount: bigint, reference: string, at: number, channelId?: string, voucherTotal?: bigint): boolean => {
    if (amount < 0n || (voucherTotal !== undefined && voucherTotal < 0n)) throw new RangeError("spend amount must not be negative");
    if (s.refs.has(reference)) return false;
    let value = amount;
    if (channelId && voucherTotal !== undefined) { const old = s.channels.get(channelId) ?? 0n; value = voucherTotal > old ? voucherTotal - old : 0n; }
    const h: Hold = { id: `settlement-${process.pid}-${randomUUID()}`, scope, micro: value, at, pid: process.pid, hostname: LOCAL, signed: true };
    append(s, "commit", scope, value, at, h, reference, channelId, voucherTotal); s.ledger.record(scope, value, at); s.refs.add(reference); s.resolved.add(h.id);
    if (channelId && voucherTotal !== undefined) raiseChannel(s, channelId, voucherTotal);
    return true;
  };

  /** One fold of this writer's journal if the lock is free now; never waits. */
  const foldOnce = (): boolean => {
    if (!existsSync(ownPending)) { exitFolds.delete(foldOnce); return true; }
    const release = tryLock(lockPath);
    if (!release) return false;
    try { locked(() => undefined)(); } finally { release(); }
    exitFolds.delete(foldOnce);
    return true;
  };
  /**
   * Fold this writer's journal, retrying the lock on timers. The background
   * flush uses unref'd timers so it never holds the process open; an explicit
   * flushPending() call keeps the event loop alive until it answers.
   */
  const flushNow = async (ref: boolean): Promise<boolean> => {
    const start = Date.now();
    for (let waitMs = 5; ; waitMs = Math.min(500, waitMs * 2)) {
      try { if (foldOnce()) return true; } catch { return false; }
      if (Date.now() - start >= FLUSH_GIVE_UP_MS) return false;
      await pauseFor(jitter(waitMs), ref);
    }
  };
  let flushing: Promise<boolean> | undefined;
  const scheduleFlush = () => {
    if (flushing) return;
    flushing = flushNow(false).catch(() => false).finally(() => { flushing = undefined; });
  };

  return {
    spentMicro: (scope, windowMs, now) => heldAndSpent(snapshot(), scope, windowMs, now),
    firstSeen: (scope) => snapshot().ledger.firstSeen(scope),
    record(scope, amount, at) {
      if (amount < 0n) throw new RangeError("spend amount must not be negative");
      const hold: Hold = { id: `legacy-${process.pid}-${randomUUID()}`, scope, micro: amount, at, pid: process.pid, hostname: LOCAL, signed: true };
      // One attempt that never waits.
      const release = tryLock(lockPath);
      if (release) {
        try { locked(s => append(s, "commit", scope, amount, at, hold))(); } finally { release(); }
        return;
      }
      // Another process holds the lock: journal the row (every read counts it from here on) and fold it in later.
      const row: PendingRow = { id: hold.id, scope, micro: amount.toString(), at, pid: process.pid, hostname: LOCAL };
      appendFileSync(ownPending, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      foldAtExit(foldOnce);
      scheduleFlush();
    },
    flushPending: () => flushNow(true),
    highestSpentMicroByChannel: (channelId) => snapshot().channels.get(channelId) ?? 0n,
    highestVoucherMicroByChannel(channelId) {
      const s = snapshot();
      let high = s.channels.get(channelId) ?? 0n;
      for (const h of s.holds.values()) if (h.channelId === channelId && h.voucherTotal !== undefined && h.voucherTotal > high) high = h.voucherTotal;
      return high;
    },
    settlementReferenceSeen: (reference) => snapshot().refs.has(reference),
    reserveAsync: (scope, amount, holdId, cap, windowMs, at) => withState(s => reserve(s, scope, amount, holdId, cap, windowMs, at)),
    reserveChannelAsync: (scope, amount, holdId, cap, windowMs, at, channelId, voucherTotal) => withState(s => reserve(s, scope, amount, holdId, cap, windowMs, at, channelId, voucherTotal)),
    markSignedAsync: (holdId) => withState(s => markSigned(s, holdId)),
    commitAsync: (holdId, reference, amount, channelId, voucherTotal) => withState(s => commit(s, holdId, reference, amount, channelId, voucherTotal)),
    releaseAsync: (holdId) => withState(s => release(s, holdId)),
    commitSettlementAsync: (scope, amount, reference, at, channelId, voucherTotal) => withState(s => commitSettlement(s, scope, amount, reference, at, channelId, voucherTotal)),
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
