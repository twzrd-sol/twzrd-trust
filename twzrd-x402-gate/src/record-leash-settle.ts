/** Host-callable after-settle recorder for TWZRD capacity leash (graph/nodes/capacity.md). */
export type LeashRecord = { locker: string; agentPubkey: string; windowStartMs: number; spentUsdcWindow: number; lastUpdatedMs: number };
export type LeashRecordStore = { records: Map<string, LeashRecord> };
export function createLeashRecordStore(): LeashRecordStore { return { records: new Map() }; }
export function recordLeashSettle(store: LeashRecordStore, locker: string, agentPubkey: string, amountUsdc: number, nowMs?: number): LeashRecord {
  const key = `${locker}:${agentPubkey}:${Math.floor((nowMs ?? Date.now()) / 86400000)}`;
  const existing = store.records.get(key);
  const updated: LeashRecord = { locker, agentPubkey, windowStartMs: existing?.windowStartMs ?? Math.floor((nowMs ?? Date.now()) / 86400000) * 86400000, spentUsdcWindow: (existing?.spentUsdcWindow ?? 0) + amountUsdc, lastUpdatedMs: nowMs ?? Date.now() };
  store.records.set(key, updated); return updated;
}
export function tallyLeashRecord(store: LeashRecordStore, locker: string, agentPubkey?: string, windowStartMs?: number): { spentUsdcWindow: number; agentInGrant: boolean; unbondActive: boolean; windowActive: boolean } {
  const keyPrefix = agentPubkey ? `${locker}:${agentPubkey}` : `${locker}:`;
  let best: LeashRecord | undefined;
  for (const [k, v] of store.records.entries()) { if (k.startsWith(keyPrefix)) best = v; }
  // Grant membership is not "has settled". Empty store must allow payment 1
  // (spent 0, window live) when the host named an agent pubkey.
  return {
    spentUsdcWindow: best?.spentUsdcWindow ?? 0,
    agentInGrant: agentPubkey != null && agentPubkey.length > 0,
    unbondActive: false,
    windowActive: true,
  };
}
