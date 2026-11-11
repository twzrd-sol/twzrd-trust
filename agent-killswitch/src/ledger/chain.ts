import * as crypto from "node:crypto";

/**
 * RFC 8785-style canonical JSON: sorted keys, no whitespace.
 * Minimal deterministic subset sufficient for chain hashing (no numbers with special float forms).
 */
export function canonicalJSON(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]));
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(value);
}

export interface ChainEntry {
  sequence: number;
  timestamp: string;
  event_type: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  entry_hash: string;
}

export const GENESIS_SEED = "twzrd-ledger-v1-genesis";
export function genesisHash(): string {
  return crypto.createHash("sha256").update(GENESIS_SEED, "utf8").digest("hex");
}

export function computeEntryHash(meta: { sequence: number; timestamp: string; event_type: string; payload: Record<string, unknown> }, prevHash: string): string {
  const canonical = canonicalJSON({ sequence: meta.sequence, timestamp: meta.timestamp, event_type: meta.event_type, payload: meta.payload });
  return crypto.createHash("sha256").update(prevHash + canonical, "utf8").digest("hex");
}

export function chainAppend(entry: Omit<ChainEntry, "prev_hash" | "entry_hash">, prevHash: string): ChainEntry {
  const entry_hash = computeEntryHash(entry, prevHash);
  return { ...entry, prev_hash: prevHash, entry_hash };
}
