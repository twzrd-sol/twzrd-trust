import * as fs from "node:fs";
import { computeEntryHash, genesisHash, type ChainEntry } from "./chain.js";

export interface VerifyResult {
  ok: boolean;
  count: number;
  brokenAt: number;
  reason?: string;
  finalHash: string;
}

export function verifyChain(entries: ChainEntry[]): VerifyResult {
  let prev = genesisHash();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.sequence !== i && !(i === 0 && e.sequence === 0)) {
      // Allow non-zero start but require monotonic +1
      if (i > 0 && e.sequence !== entries[i - 1]!.sequence + 1) {
        return { ok: false, count: i, brokenAt: i, reason: "sequence gap", finalHash: prev };
      }
    }
    if (e.prev_hash !== prev) {
      return { ok: false, count: i, brokenAt: i, reason: "prev_hash mismatch", finalHash: prev };
    }
    const expect = computeEntryHash({ sequence: e.sequence, timestamp: e.timestamp, event_type: e.event_type, payload: e.payload }, prev);
    if (expect !== e.entry_hash) {
      return { ok: false, count: i, brokenAt: i, reason: "entry_hash mismatch", finalHash: prev };
    }
    prev = e.entry_hash;
  }
  return { ok: true, count: entries.length, brokenAt: -1, finalHash: prev };
}

export function verifyChainFile(filePath: string): VerifyResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { ok: true, count: 0, brokenAt: -1, finalHash: genesisHash() };
  }
  const entries: ChainEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as ChainEntry;
      // Backward compat: pre-chain LedgerLine has no sequence/entry_hash — skip chain check
      if (obj.entry_hash === undefined || obj.sequence === undefined) continue;
      entries.push(obj);
    } catch {
      continue;
    }
  }
  return verifyChain(entries);
}
