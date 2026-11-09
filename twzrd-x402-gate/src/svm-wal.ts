/**
 * Track 6 — SVM Execution Write-Ahead Log (`twzrd.svm_wal.v1`).
 *
 * Treating local disk as a write-ahead log (WAL) for on-chain settlement:
 * 1. Before any signing key is touched, `lookupChallenge(challengeHash)` checks
 *    whether the challenge was already confirmed (idempotent replay, 0 signer
 *    invocations) or whether ANY intent in the WAL is still unresolved (freezes
 *    the loop with `wal_unresolved_intent`).
 * 2. `appendIntent` writes a pre-sign `payment_intent` row (`challenge_hash`,
 *    `amount_micro`, `payment_decision_id`, `prev` — never `tx_signature`,
 *    which does not exist before signing) and flushes it to disk via
 *    `fsyncSync` BEFORE the payer callback runs. If `fsyncSync` fails, the
 *    intent is not recorded in memory and the signing key is never invoked.
 * 3. After broadcast + RPC terminal confirmation, `appendReceipt` writes and
 *    `fsync`s the matching `payment_receipt` row (`confirmed` | `failed` |
 *    `expired_blockhash`). A `confirmed` receipt requires both a non-empty
 *    `tx_signature` and a positive integer `slot`.
 * 4. If the process crashes after writing `payment_intent` (before
 *    `payment_receipt`), replaying the file on startup leaves that intent
 *    unresolved: `hasUnresolvedIntent()` is true, `heldMicro()` and
 *    `spentMicro()` count the in-flight and recovered confirmed funds against
 *    budget caps, and the payment loop stays frozen until
 *    `recoverUnresolvedIntents(poller)` writes the terminal receipt.
 * 5. Single-writer lock (`<filePath>.lock`): prevents two processes or two
 *    concurrent writer instances from interleaving appends and breaking the
 *    hash chain.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const SVM_WAL_SCHEMA = "twzrd.svm_wal.v1" as const;

export type SvmWalReceiptStatus = "confirmed" | "failed" | "expired_blockhash";

export type SvmWalIntentRow = {
  schema: typeof SVM_WAL_SCHEMA;
  kind: "payment_intent";
  intent_id: string;
  challenge_hash: string;
  payment_decision_id: string;
  pay_to: string;
  amount_micro: string;
  network: string;
  last_valid_block_height?: number;
  at_unix_ms: number;
  prev: string;
};

export type SvmWalReceiptRow = {
  schema: typeof SVM_WAL_SCHEMA;
  kind: "payment_receipt";
  intent_id: string;
  challenge_hash: string;
  tx_signature: string | null;
  status: SvmWalReceiptStatus;
  slot: number | null;
  at_unix_ms: number;
  prev: string;
};

export type SvmWalRow = SvmWalIntentRow | SvmWalReceiptRow;

export type AppendSvmWalIntentInput = {
  intentId?: string;
  challengeHash: string;
  paymentDecisionId: string;
  payTo: string;
  amountMicro: string | bigint;
  network: string;
  lastValidBlockHeight?: number;
  atUnixMs?: number;
};

export type AppendSvmWalReceiptInput = {
  intentId: string;
  status: SvmWalReceiptStatus;
  txSignature?: string | null;
  slot?: number | null;
  atUnixMs?: number;
};

export type SvmWalLookupResult =
  | { state: "absent" }
  | { state: "pending"; intent: SvmWalIntentRow }
  | { state: "confirmed"; intent: SvmWalIntentRow; receipt: SvmWalReceiptRow }
  | { state: "failed"; intent: SvmWalIntentRow; receipt: SvmWalReceiptRow };

export type SvmWalPollOutcome =
  | { status: "pending" }
  | {
      status: SvmWalReceiptStatus;
      txSignature?: string | null;
      slot?: number | null;
    };

export type SvmWalPoller = (intent: SvmWalIntentRow) => Promise<SvmWalPollOutcome>;

export type CreateSvmWalOptions = {
  /** Injectable fsync implementation for deterministic disk-failure testing. */
  fsyncFn?: (fd: number) => void;
};

export type SvmWalSpentMicroOptions = {
  payTo?: string;
  windowMs?: number;
  now?: number;
  excludeIntentIds?: ReadonlySet<string>;
};

export type SvmWal = {
  lookupChallenge(challengeHash: string): SvmWalLookupResult;
  hasUnresolvedIntent(): boolean;
  unresolvedIntents(): readonly SvmWalIntentRow[];
  heldMicro(): bigint;
  confirmedMicro(): bigint;
  /** Sum of unresolved (held) + confirmed spend in micro-USDC, optionally scoped by payTo/window. */
  spentMicro(options?: SvmWalSpentMicroOptions): bigint;
  appendIntent(input: AppendSvmWalIntentInput): SvmWalIntentRow;
  appendReceipt(input: AppendSvmWalReceiptInput): SvmWalReceiptRow;
  recoverUnresolvedIntents(poller: SvmWalPoller): Promise<{
    resolved: number;
    pending: number;
    receipts: SvmWalReceiptRow[];
  }>;
  /** Release the single-writer lockfile held by this WAL instance. */
  close(): void;
};

const GENESIS = "genesis";
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const VALID_STATUSES: ReadonlySet<string> = new Set([
  "confirmed",
  "failed",
  "expired_blockhash",
]);

const activeExitCleanups = new Set<() => void>();
let exitHookRegistered = false;
function registerExitCleanup(fn: () => void): void {
  activeExitCleanups.add(fn);
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once("exit", () => {
      for (const cleanup of activeExitCleanups) {
        try {
          cleanup();
        } catch {
          /* ignore exit cleanup errors */
        }
      }
      activeExitCleanups.clear();
    });
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockOwner(lockPath: string): { pid: number; instanceId: string } | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; instanceId?: unknown };
    if (typeof parsed.pid === "number" && typeof parsed.instanceId === "string") {
      return { pid: parsed.pid, instanceId: parsed.instanceId };
    }
    return null;
  } catch {
    return null;
  }
}

function validateIntentRow(row: SvmWalIntentRow, filePath: string): void {
  if ("tx_signature" in (row as Record<string, unknown>) || "txSignature" in (row as Record<string, unknown>)) {
    throw new Error(
      `[twzrd-x402-gate] svm wal payment_intent must not carry tx_signature before signing: ${filePath}`,
    );
  }
  if (
    typeof row.intent_id !== "string" ||
    !row.intent_id ||
    typeof row.challenge_hash !== "string" ||
    !row.challenge_hash ||
    typeof row.payment_decision_id !== "string" ||
    !row.payment_decision_id ||
    typeof row.pay_to !== "string" ||
    !row.pay_to ||
    typeof row.amount_micro !== "string" ||
    !/^\d+$/.test(row.amount_micro) ||
    typeof row.network !== "string" ||
    !row.network ||
    typeof row.at_unix_ms !== "number" ||
    !Number.isFinite(row.at_unix_ms)
  ) {
    throw new Error(`[twzrd-x402-gate] svm wal invalid payment_intent row: ${filePath}`);
  }
}

function validateReceiptRow(row: SvmWalReceiptRow, filePath: string): void {
  if (
    typeof row.intent_id !== "string" ||
    !row.intent_id ||
    typeof row.challenge_hash !== "string" ||
    !row.challenge_hash ||
    !VALID_STATUSES.has(row.status) ||
    (row.tx_signature !== null && typeof row.tx_signature !== "string") ||
    (row.slot !== null && (typeof row.slot !== "number" || !Number.isFinite(row.slot))) ||
    typeof row.at_unix_ms !== "number" ||
    !Number.isFinite(row.at_unix_ms)
  ) {
    throw new Error(`[twzrd-x402-gate] svm wal invalid payment_receipt row: ${filePath}`);
  }
  if (row.status === "confirmed") {
    const hasSig = typeof row.tx_signature === "string" && row.tx_signature.trim().length > 0;
    const hasSlot = typeof row.slot === "number" && Number.isInteger(row.slot) && row.slot > 0;
    if (!hasSig || !hasSlot) {
      throw new Error(
        `[twzrd-x402-gate] svm wal confirmed payment_receipt requires non-empty tx_signature and positive integer slot: ${filePath}`,
      );
    }
  }
}

export function createFileSvmWal(filePath: string, options: CreateSvmWalOptions = {}): SvmWal {
  const resolvedPath = path.resolve(filePath);
  const lockPath = `${resolvedPath}.lock`;
  const instanceId = randomUUID();
  const fsyncFn = options.fsyncFn ?? ((fd: number) => fs.fsyncSync(fd));
  let lastHash = GENESIS;
  const intentsById = new Map<string, SvmWalIntentRow>();
  const receiptsByIntentId = new Map<string, SvmWalReceiptRow>();
  const intentsByChallenge = new Map<string, SvmWalIntentRow[]>();

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  // Check if another live process already holds the single-writer lock
  const existingLock = readLockOwner(lockPath);
  if (existingLock && existingLock.pid !== process.pid && isPidAlive(existingLock.pid)) {
    throw new Error(
      `[twzrd-x402-gate] wal_single_writer_lock: ${resolvedPath} is locked by pid ${existingLock.pid}`,
    );
  }

  let raw = "";
  try {
    raw = fs.readFileSync(resolvedPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let bytesConsumed = Buffer.byteLength(raw, "utf8");

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`[twzrd-x402-gate] svm wal corrupt row: ${resolvedPath}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`[twzrd-x402-gate] svm wal corrupt row: ${resolvedPath}`);
    }
    const row = parsed as SvmWalRow;
    if (row.schema !== SVM_WAL_SCHEMA) {
      throw new Error(`[twzrd-x402-gate] svm wal unsupported schema: ${resolvedPath}`);
    }
    if (row.prev !== lastHash) {
      throw new Error(`[twzrd-x402-gate] svm wal chain broken: ${resolvedPath}`);
    }
    if (row.kind === "payment_intent") {
      validateIntentRow(row, resolvedPath);
      if (intentsById.has(row.intent_id)) {
        throw new Error(`[twzrd-x402-gate] svm wal duplicate intent_id ${row.intent_id}: ${resolvedPath}`);
      }
      intentsById.set(row.intent_id, row);
      const list = intentsByChallenge.get(row.challenge_hash) ?? [];
      list.push(row);
      intentsByChallenge.set(row.challenge_hash, list);
    } else if (row.kind === "payment_receipt") {
      validateReceiptRow(row, resolvedPath);
      const intent = intentsById.get(row.intent_id);
      if (!intent || intent.challenge_hash !== row.challenge_hash) {
        throw new Error(
          `[twzrd-x402-gate] svm wal orphan or mismatched payment_receipt for ${row.intent_id}: ${resolvedPath}`,
        );
      }
      if (receiptsByIntentId.has(row.intent_id)) {
        throw new Error(
          `[twzrd-x402-gate] svm wal duplicate payment_receipt for ${row.intent_id}: ${resolvedPath}`,
        );
      }
      receiptsByIntentId.set(row.intent_id, row);
    } else {
      throw new Error(`[twzrd-x402-gate] svm wal unknown row kind: ${resolvedPath}`);
    }
    lastHash = sha256(line);
  }

  const claimWriterLock = (): void => {
    const owner = readLockOwner(lockPath);
    if (owner) {
      if (owner.pid !== process.pid && isPidAlive(owner.pid)) {
        throw new Error(
          `[twzrd-x402-gate] wal_single_writer_lock: ${resolvedPath} is locked by pid ${owner.pid}`,
        );
      }
      if (owner.pid === process.pid && owner.instanceId === instanceId) {
        return;
      }
      // Stale lock from dead PID, or another instance in the same process when we are up-to-date with the tail
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, instanceId }) + "\n",
          "utf8",
        );
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const current = readLockOwner(lockPath);
        if (current && (current.pid !== process.pid || current.instanceId !== instanceId)) {
          throw new Error(
            `[twzrd-x402-gate] wal_single_writer_lock: ${resolvedPath} is locked by pid ${current.pid}`,
          );
        }
        return;
      }
      throw err;
    }
  };

  // Claim the single-writer lock on open if no same-process instance already holds it
  if (!existingLock) {
    claimWriterLock();
  }

  const releaseWriterLock = (): void => {
    activeExitCleanups.delete(releaseWriterLock);
    const owner = readLockOwner(lockPath);
    if (owner && owner.pid === process.pid && owner.instanceId === instanceId) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* already removed */
      }
    }
  };
  registerExitCleanup(releaseWriterLock);

  const writeAndFsyncLine = (line: string): void => {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    let diskSize = 0;
    try {
      diskSize = fs.statSync(resolvedPath).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (diskSize !== bytesConsumed) {
      throw new Error(
        `[twzrd-x402-gate] wal_single_writer_lock: ${resolvedPath} was modified by another writer (expected ${bytesConsumed} bytes, found ${diskSize})`,
      );
    }
    claimWriterLock();
    const payload = line + "\n";
    const fd = fs.openSync(resolvedPath, "a", 0o600);
    try {
      fs.writeFileSync(fd, payload, "utf8");
      fsyncFn(fd);
    } finally {
      fs.closeSync(fd);
    }
    bytesConsumed += Buffer.byteLength(payload, "utf8");
  };

  const getUnresolved = (): SvmWalIntentRow[] => {
    const out: SvmWalIntentRow[] = [];
    for (const intent of intentsById.values()) {
      if (!receiptsByIntentId.has(intent.intent_id)) {
        out.push(intent);
      }
    }
    return out;
  };

  return {
    lookupChallenge(challengeHash: string): SvmWalLookupResult {
      const list = intentsByChallenge.get(challengeHash);
      if (!list || list.length === 0) return { state: "absent" };
      for (const intent of list) {
        const rec = receiptsByIntentId.get(intent.intent_id);
        if (rec && rec.status === "confirmed") {
          return { state: "confirmed", intent, receipt: rec };
        }
      }
      for (const intent of list) {
        if (!receiptsByIntentId.has(intent.intent_id)) {
          return { state: "pending", intent };
        }
      }
      const lastIntent = list[list.length - 1]!;
      const lastReceipt = receiptsByIntentId.get(lastIntent.intent_id)!;
      return { state: "failed", intent: lastIntent, receipt: lastReceipt };
    },

    hasUnresolvedIntent(): boolean {
      for (const id of intentsById.keys()) {
        if (!receiptsByIntentId.has(id)) return true;
      }
      return false;
    },

    unresolvedIntents(): readonly SvmWalIntentRow[] {
      return getUnresolved();
    },

    heldMicro(): bigint {
      let sum = 0n;
      for (const intent of intentsById.values()) {
        if (!receiptsByIntentId.has(intent.intent_id)) {
          sum += BigInt(intent.amount_micro);
        }
      }
      return sum;
    },

    confirmedMicro(): bigint {
      let sum = 0n;
      for (const [id, receipt] of receiptsByIntentId.entries()) {
        if (receipt.status === "confirmed") {
          const intent = intentsById.get(id);
          if (intent) sum += BigInt(intent.amount_micro);
        }
      }
      return sum;
    },

    spentMicro(opts: SvmWalSpentMicroOptions = {}): bigint {
      const now = opts.now ?? Date.now();
      let sum = 0n;
      for (const intent of intentsById.values()) {
        if (opts.excludeIntentIds?.has(intent.intent_id)) continue;
        if (opts.payTo !== undefined && intent.pay_to !== opts.payTo) continue;
        if (opts.windowMs !== undefined && now - intent.at_unix_ms > opts.windowMs) continue;
        const receipt = receiptsByIntentId.get(intent.intent_id);
        if (!receipt || receipt.status === "confirmed") {
          sum += BigInt(intent.amount_micro);
        }
      }
      return sum;
    },

    appendIntent(input: AppendSvmWalIntentInput): SvmWalIntentRow {
      if ("txSignature" in (input as Record<string, unknown>) || "tx_signature" in (input as Record<string, unknown>)) {
        throw new Error(
          `[twzrd-x402-gate] svm wal payment_intent must not carry tx_signature before signing: ${resolvedPath}`,
        );
      }
      if (this.hasUnresolvedIntent()) {
        throw new Error(
          "[twzrd-x402-gate] wal_unresolved_intent: cannot append new payment_intent while an earlier intent has no receipt",
        );
      }
      const existing = this.lookupChallenge(input.challengeHash);
      if (existing.state === "confirmed") {
        throw new Error(
          "[twzrd-x402-gate] wal_challenge_already_confirmed: challenge_hash already has a confirmed payment_receipt",
        );
      }
      const amountStr = String(input.amountMicro);
      if (!/^\d+$/.test(amountStr)) {
        throw new Error(`[twzrd-x402-gate] svm wal invalid amountMicro: ${amountStr}`);
      }
      const row: SvmWalIntentRow = {
        schema: SVM_WAL_SCHEMA,
        kind: "payment_intent",
        intent_id: input.intentId ?? randomUUID(),
        challenge_hash: input.challengeHash,
        payment_decision_id: input.paymentDecisionId,
        pay_to: input.payTo,
        amount_micro: amountStr,
        network: input.network,
        ...(input.lastValidBlockHeight !== undefined
          ? { last_valid_block_height: input.lastValidBlockHeight }
          : {}),
        at_unix_ms: input.atUnixMs ?? Date.now(),
        prev: lastHash,
      };
      validateIntentRow(row, resolvedPath);
      const line = JSON.stringify(row);
      // Disk + fsync BEFORE in-memory mutation and BEFORE the signing key is touched.
      writeAndFsyncLine(line);
      lastHash = sha256(line);
      intentsById.set(row.intent_id, row);
      const list = intentsByChallenge.get(row.challenge_hash) ?? [];
      list.push(row);
      intentsByChallenge.set(row.challenge_hash, list);
      return row;
    },

    appendReceipt(input: AppendSvmWalReceiptInput): SvmWalReceiptRow {
      const intent = intentsById.get(input.intentId);
      if (!intent) {
        throw new Error(`[twzrd-x402-gate] svm wal unknown intent_id: ${input.intentId}`);
      }
      if (receiptsByIntentId.has(input.intentId)) {
        throw new Error(
          `[twzrd-x402-gate] svm wal receipt already recorded for intent_id: ${input.intentId}`,
        );
      }
      const txSig =
        typeof input.txSignature === "string" && input.txSignature.trim().length > 0
          ? input.txSignature.trim()
          : null;
      const row: SvmWalReceiptRow = {
        schema: SVM_WAL_SCHEMA,
        kind: "payment_receipt",
        intent_id: input.intentId,
        challenge_hash: intent.challenge_hash,
        tx_signature: txSig,
        status: input.status,
        slot: input.slot ?? null,
        at_unix_ms: input.atUnixMs ?? Date.now(),
        prev: lastHash,
      };
      validateReceiptRow(row, resolvedPath);
      const line = JSON.stringify(row);
      writeAndFsyncLine(line);
      lastHash = sha256(line);
      receiptsByIntentId.set(row.intent_id, row);
      return row;
    },

    async recoverUnresolvedIntents(poller: SvmWalPoller) {
      const unresolved = getUnresolved();
      const receipts: SvmWalReceiptRow[] = [];
      let pending = 0;
      for (const intent of unresolved) {
        const outcome = await poller(intent);
        if (outcome.status === "pending") {
          pending += 1;
          continue;
        }
        const rec = this.appendReceipt({
          intentId: intent.intent_id,
          status: outcome.status,
          txSignature: outcome.txSignature ?? null,
          slot: outcome.slot ?? null,
        });
        receipts.push(rec);
      }
      return {
        resolved: receipts.length,
        pending,
        receipts,
      };
    },

    close(): void {
      releaseWriterLock();
    },
  };
}

const fileWals = new Map<string, SvmWal>();

export function sharedFileSvmWal(filePath: string): SvmWal {
  const key = path.resolve(filePath);
  let wal = fileWals.get(key);
  if (!wal) {
    wal = createFileSvmWal(key);
    fileWals.set(key, wal);
  }
  return wal;
}

export function __resetSharedFileSvmWals(): void {
  for (const wal of fileWals.values()) {
    wal.close();
  }
  fileWals.clear();
}
