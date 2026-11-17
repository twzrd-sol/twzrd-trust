/**
 * `twzrd.mandate.heartbeat.v1`: a statement, signed by the agent key, of
 * what a runtime has decided and spent so far and where its decision ledger
 * stands. Heartbeats chain: each names the hash of the one before it, so a
 * missing or rewritten heartbeat shows.
 *
 * A heartbeat is the runtime's own claim. It proves the agent key signed
 * these figures over this ledger head; it does not prove a transfer on a
 * chain.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "twzrd-x402-gate";
import { verifySignature } from "./keys.js";
import { STATE_FILES, type MandateRuntime } from "./runtime.js";

export const HEARTBEAT_SCHEMA = "twzrd.mandate.heartbeat.v1";
export const HEARTBEAT_SIGNING_DOMAIN = "TWZRD:MANDATE_HEARTBEAT_V1\n";
export const HEARTBEAT_GENESIS = "genesis";
export const HEARTBEAT_LOG = "heartbeats.jsonl";

export interface HeartbeatBody {
  schema: typeof HEARTBEAT_SCHEMA;
  mandateId: string;
  agent: string;
  seq: number;
  at: string;
  decisions: number;
  refusals: number;
  settledUsd: string;
  remainingBudgetUsd: { hour: string; day: string };
  ledgerHeadHash: string;
  /** Hash of the previous heartbeat, or "genesis". */
  prevHeartbeatHash: string;
}

export interface Heartbeat extends HeartbeatBody {
  signature: { alg: "ed25519"; publicKey: string; value: string };
}

function signingBytes(body: HeartbeatBody): Buffer {
  return Buffer.from(HEARTBEAT_SIGNING_DOMAIN + canonicalJson(body), "utf8");
}

/** SHA-256 (hex) of a heartbeat's canonical JSON, signature included. */
export function heartbeatHash(heartbeat: Heartbeat): string {
  return crypto.createHash("sha256").update(canonicalJson(heartbeat)).digest("hex");
}

/** Sign and record the next heartbeat. Needs the agent key. */
export function emitHeartbeat(runtime: MandateRuntime, now: number = Date.now()): Heartbeat {
  const key = runtime.agentKey;
  if (!key) throw new Error("a heartbeat is signed by the agent key, and this runtime was started without one");
  const lastPath = path.join(runtime.stateDir, STATE_FILES.heartbeat);
  let seq = 1;
  let prev = HEARTBEAT_GENESIS;
  if (fs.existsSync(lastPath)) {
    const last = JSON.parse(fs.readFileSync(lastPath, "utf8")) as Heartbeat;
    const checked = verifyHeartbeat(last, { agent: runtime.mandate.agent });
    if (!checked.ok) throw new Error(`the last heartbeat on disk does not verify (${checked.detail}); refusing to chain onto it`);
    seq = last.seq + 1;
    prev = heartbeatHash(last);
  }
  const status = runtime.status();
  const body: HeartbeatBody = {
    schema: HEARTBEAT_SCHEMA,
    mandateId: runtime.mandate.mandateId,
    agent: key.publicKey,
    seq,
    at: new Date(Math.floor(now / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    decisions: status.counters.decisions,
    refusals: status.counters.refusals,
    settledUsd: status.counters.settledUsd,
    remainingBudgetUsd: { hour: status.spend.remainingHourUsd, day: status.spend.remainingDayUsd },
    ledgerHeadHash: status.ledger.head,
    prevHeartbeatHash: prev,
  };
  const heartbeat: Heartbeat = {
    ...body,
    signature: { alg: "ed25519", publicKey: key.publicKey, value: key.sign(signingBytes(body)).toString("base64") },
  };
  fs.appendFileSync(path.join(runtime.stateDir, HEARTBEAT_LOG), `${JSON.stringify(heartbeat)}\n`, { mode: 0o600 });
  const tmp = `${lastPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(heartbeat, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, lastPath);
  return heartbeat;
}

/** The last heartbeat this state directory recorded, if any. */
export function lastHeartbeat(stateDir: string): Heartbeat | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, STATE_FILES.heartbeat), "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}

/** Verify a heartbeat's shape and signature. `agent`, when given, must be the signer. Never throws. */
export function verifyHeartbeat(input: unknown, opts: { agent?: string } = {}): { ok: true } | { ok: false; detail: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, detail: "not an object" };
  const { signature, ...rest } = input as Record<string, unknown>;
  const body = rest as unknown as HeartbeatBody;
  if (body.schema !== HEARTBEAT_SCHEMA) return { ok: false, detail: "wrong schema" };
  if (typeof body.agent !== "string" || typeof body.mandateId !== "string") return { ok: false, detail: "missing agent or mandateId" };
  if (!Number.isInteger(body.seq) || body.seq < 1) return { ok: false, detail: "seq is not a positive integer" };
  if (typeof body.ledgerHeadHash !== "string" || typeof body.prevHeartbeatHash !== "string") return { ok: false, detail: "missing a hash" };
  const sig = signature as { alg?: unknown; publicKey?: unknown; value?: unknown } | undefined;
  if (!sig || sig.alg !== "ed25519" || typeof sig.publicKey !== "string" || typeof sig.value !== "string") {
    return { ok: false, detail: "no ed25519 signature" };
  }
  if (sig.publicKey !== body.agent) return { ok: false, detail: "the signature key is not the heartbeat's agent" };
  if (opts.agent !== undefined && opts.agent !== body.agent) return { ok: false, detail: "the heartbeat is signed by a different agent" };
  const bytes = Buffer.from(sig.value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== sig.value) return { ok: false, detail: "the signature is not canonical base64" };
  let valid = false;
  try {
    valid = verifySignature(body.agent, signingBytes(body), bytes);
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, detail: "the signature does not verify" };
}
