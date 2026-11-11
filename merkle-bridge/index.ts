/*
 * Spend-ledger Merkle bridge: agent-killswitch JSONL ledger bytes to an
 * RFC 6962 Keccak-256 Merkle tree (the tree shape of docs/transparency-log.md).
 *
 * The bridge verifies the hash chain over the exact bytes it leaf-hashes.
 * It does not take a verification report from the caller: a report is not
 * bound to any bytes, so it cannot vouch for them.
 *
 * Offline: no network, no keys, no signing, no anchoring, no STH. It computes
 * the leaves and the root a later, separately authorized step could sign.
 * See README.md in this folder for the normative rules.
 */
import { createHash } from "node:crypto";
import { assertHashBackend, leafHash, merkleRoot } from "../twzrd-log-verifier/src/merkle.js";

/** `prev` of the first row of a ledger file (agent-killswitch `GENESIS`). */
export const GENESIS = "genesis";
const LF = 0x0a;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The ledger is not something the bridge will leaf-hash. */
export class LedgerNotBridgeable extends Error {
  /** 1-based line number, or null when the refusal is about the whole ledger. */
  readonly line: number | null;
  constructor(line: number | null, reason: string) {
    super(
      line === null
        ? `refusing to build Merkle leaves: ${reason}`
        : `refusing to build Merkle leaves: line ${line}: ${reason}`,
    );
    this.name = "LedgerNotBridgeable";
    this.line = line;
  }
}

/** SHA-256 hex of a line's exact bytes: agent-killswitch `lineHash`. */
export function lineHash(line: Uint8Array): string {
  return createHash("sha256").update(line).digest("hex");
}

/**
 * Split ledger bytes into lines at LF. Each line is its exact bytes without
 * the LF (a CR before the LF stays in the line, as the chain hashes it).
 * Refuses bytes after the last LF (a torn or in-progress write) and empty
 * lines (the chain skips them, so nothing binds them).
 */
export function splitLedgerLines(ledger: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let from = 0;
  for (let i = 0; i < ledger.length; i++) {
    if (ledger[i] !== LF) continue;
    if (i === from) throw new LedgerNotBridgeable(lines.length + 1, "empty line (the chain does not bind it)");
    lines.push(ledger.subarray(from, i));
    from = i + 1;
  }
  if (from < ledger.length) {
    throw new LedgerNotBridgeable(
      lines.length + 1,
      "bytes after the last newline (a torn or in-progress write); bridge a ledger at rest",
    );
  }
  return lines;
}

/**
 * Check that the lines form one unbroken chain from genesis: every line is a
 * JSON object whose own `prev` is "genesis" on line 1 and the SHA-256 hex of
 * the previous line's exact bytes after that. Returns the head (SHA-256 of
 * the last line), or null for an empty ledger.
 *
 * Stricter than `agent-killswitch verify-ledger --strict`, which also accepts
 * rows written before the chain existed (`legacy`), empty lines and a torn
 * tail. Nothing binds those bytes, so the bridge refuses them.
 */
export function verifyLinearChain(lines: readonly Uint8Array[]): string | null {
  let expected = GENESIS;
  let head: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNo = index + 1;
    let row: unknown;
    try {
      row = JSON.parse(UTF8.decode(line));
    } catch {
      throw new LedgerNotBridgeable(lineNo, "not valid UTF-8 JSON");
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new LedgerNotBridgeable(lineNo, "not a JSON object");
    }
    if (!Object.prototype.hasOwnProperty.call(row, "prev")) {
      throw new LedgerNotBridgeable(lineNo, "no prev (a row the chain does not bind)");
    }
    const prev = (row as { prev: unknown }).prev;
    if (prev !== expected) {
      throw new LedgerNotBridgeable(
        lineNo,
        lineNo === 1
          ? `prev must be "${GENESIS}" on the first line`
          : "prev is not the SHA-256 of the line before it (an edit, removal, reorder or fork)",
      );
    }
    head = lineHash(line);
    expected = head;
  }
  return head;
}

export interface BridgeOptions {
  /**
   * The head recorded earlier for this ledger (SHA-256 hex of its last line,
   * the `head` of `agent-killswitch verify-ledger --json`). When given, the
   * bridge refuses unless the bytes end at that head. Without it, a ledger
   * rewritten end to end with fresh `prev` values still bridges: the chain
   * shows partial edits, not a full rewrite.
   */
  expectedHead?: string;
}

export interface BridgeResult {
  /** Number of leaves: one per ledger line. */
  treeSize: number;
  /** RFC 6962 root; keccak256("") when treeSize is 0. */
  root: Uint8Array;
  rootHex: string;
  /** Leaf hashes, hex, in ledger order. leaves[i] commits to line i + 1. */
  leaves: string[];
  /** SHA-256 hex of the last line (the chain head), or null when empty. */
  chainHead: string | null;
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Verify the chain over `ledger` (a whole ledger file, read once) and leaf-hash
 * the same bytes. Throws LedgerNotBridgeable on anything the chain does not
 * bind. Deterministic: the same bytes give the same leaves and root.
 */
export function bridgeSpendLedger(ledger: Uint8Array, options: BridgeOptions = {}): BridgeResult {
  assertHashBackend();
  const lines = splitLedgerLines(ledger);
  const chainHead = verifyLinearChain(lines);
  if (options.expectedHead !== undefined && options.expectedHead !== chainHead) {
    throw new LedgerNotBridgeable(null, "the ledger does not end at the expected head");
  }
  const root = merkleRoot(lines);
  return {
    treeSize: lines.length,
    root,
    rootHex: hex(root),
    leaves: lines.map((line) => hex(leafHash(line))),
    chainHead,
  };
}
