/**
 * The mandate runtime: one verified mandate, one state directory, and the
 * pipeline every call goes through.
 *
 *   1 mandate integrity   the mandate is still in force
 *   2 halt switches       `.kill` / `.pause` in the state directory
 *   3 tool allow-list     the tool is named in the mandate
 *   4 spend caps          per call, hour, day (tool guard), day, month (gate)
 *   5 trust screen        chain, counterparties, TWZRD preflight and wash
 *   6 challenge integrity the 402 is readable, priced, and still the offer
 *                         that was approved when it reaches the payer
 *
 * Everything above happens before the payer sees a 402. The runtime holds no
 * wallet: signing is done by the pay module the operator supplies, and it is
 * only ever handed a 402 that carries the one offer the pipeline approved.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createToolGuard, type ToolGuard, type ToolHold } from "@twzrd1111/agent-killswitch";
import {
  createFileSpendLedger,
  createLocalDecisionSigner,
  createTwzrdPolicyFetch,
  PAYMENT_REQUIRED_UNREADABLE,
  readSentinelState,
  resolveConfig,
  twzrdApprovePayment,
  TwzrdPolicyAbortError,
  TwzrdWashAbortError,
  writePauseSentinel,
} from "twzrd-x402-gate";
import { type PricedOffer, type X402Challenge, narrowChallenge, readChallenge, readOffer, sameOffer, strictBase64ToUtf8 } from "./challenge.js";
import type { MandateKey } from "./keys.js";
import { type DecisionInput, type DecisionLedger, type DecisionRecord, ledgerAgreesWithHeartbeat, openDecisionLedger } from "./ledger.js";
import { type InclusionCheck, type ReceiptCheck, checkInclusion, checkReceipt, findInclusion, findReceipt } from "./receipts.js";
import { type Mandate, mandateLimitsMicro, microToUsd } from "./schema.js";

export const STATE_FILES = {
  kill: ".kill",
  pause: ".pause",
  lock: "mandate.lock",
  toolLedger: "spend-ledger.jsonl",
  gateLedger: "payment-spend-ledger.jsonl",
  decisionLedger: "mandate-ledger.jsonl",
  heartbeat: "heartbeat.json",
} as const;

/** Largest request or response body the runtime will buffer. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const RECEIPT_PAUSE_REASON = "mandate_receipt_violation";
export const SPEND_RECORD_PAUSE_REASON = "mandate_spend_record_failed";
export const SETTLEMENT_PAUSE_REASON = "mandate_settlement_mismatch";
export const UNRESOLVED_PAUSE_REASON = "mandate_payment_unresolved";
/** Receipt leaves this state directory has accepted, one per line. */
export const RECEIPT_LEAVES_FILE = "receipt-leaves.txt";
export const DEFAULT_RECEIPT_MAX_AGE_SECONDS = 900;
export const DEFAULT_DEDUPE_WINDOW_SECONDS = 60;
export const MAX_DEDUPE_WINDOW_SECONDS = 86_400;
const MIN_TRIP_PAUSE_MS = 60_000;
const GUARD_MAX_TRIP_PAUSE_MS = 86_400_000;
const MICRO = 1_000_000;

/** What a pay module exports: it wraps a fetch that returns 402s and pays them. */
export type WrapPay = (guarded: typeof fetch) => typeof fetch;

export type CallOutcome = "free" | "settled" | "refused" | "violation" | "error";

export interface Refusal {
  /** Pre-sign refusal layer, 1 to 6. Null for an error or a post-payment violation. */
  layer: number | null;
  code: string;
  detail: string;
}

export interface CallRequest {
  /** The tool name checked against `allowedTools`, such as `http:api.example.com` or `mcp:search`. */
  tool: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
  requestId?: string;
  /**
   * The transport for this call, in place of the runtime's own fetch. Used by
   * adapters that turn another payment carrier (an MCP tool result) into the
   * HTTP 402 exchange the pipeline understands.
   */
  transport?: typeof fetch;
}

export interface CallResult {
  outcome: CallOutcome;
  /** The response to hand to the agent. A refusal or a withheld response is a JSON error document. */
  status: number;
  headers: Headers;
  body: Uint8Array;
  /** True when `body` is the target's own response; false when it is the runtime's error document. */
  delivered: boolean;
  refusal: Refusal | null;
  /** Requests that left this process carrying a payment. Zero for every refusal. */
  signatures: number;
  quotedUsd: string | null;
  settledUsd: string | null;
  payTo: string | null;
  receipt: ReceiptCheck | null;
  inclusion: InclusionCheck | null;
  record: DecisionRecord;
}

export interface RuntimeCounters {
  decisions: number;
  refusals: number;
  settled: number;
  free: number;
  violations: number;
  errors: number;
  settledMicro: bigint;
  signatures: number;
}

export interface RuntimeStatus {
  schema: "twzrd.mandate.status.v1";
  mandate: {
    mandateId: string;
    issuerMode: string;
    issuer: string;
    agent: string;
    issuedAt: string;
    expiresAt: string;
    expired: boolean;
    task: string | null;
    limits: Mandate["limits"];
    allowedChains: string[];
    minTrustScore: number;
    trustScreen: "required" | "off";
    allowedTools: string[];
    requireV7Receipt: boolean;
    requireMerkleInclusion: boolean;
  };
  /** Seconds an identical purchase is refused for after its payment left; 0 when the check is off. */
  dedupeWindowSeconds: number;
  halt: { active: boolean; mode: string | null; reason: string | null; untilUnixMs: number | null };
  spend: { hourUsd: string; dayUsd: string; remainingHourUsd: string; remainingDayUsd: string };
  counters: { decisions: number; refusals: number; settled: number; free: number; violations: number; errors: number; settledUsd: string; signatures: number };
  ledger: { path: string; lines: number; head: string };
  payer: "configured" | "none";
  stateDir: string;
}

export interface MandateRuntimeOptions {
  /** A mandate that `verifyMandate` or `loadMandateFile` accepted. */
  mandate: Mandate;
  expiresAtMs: number;
  /** The resolved state directory (`killswitchDir`). */
  stateDir: string;
  /** The pay module's wrapper. Without one every 402 is refused. */
  wrapPay?: WrapPay;
  /** The agent key, for signing heartbeats. Must be the mandate's agent. */
  agentKey?: MandateKey;
  intelBase?: string;
  /** Where inclusion proofs are fetched when a response carries none. Defaults to `intelBase`. */
  logBaseUrl?: string;
  /** Transport for every outbound request. Default: global fetch. */
  fetch?: typeof fetch;
  /**
   * How long a violation pauses the state directory. Default: until the
   * mandate expires, so only `resume` with the control token clears it.
   */
  tripPauseMs?: number;
  /**
   * Oldest receipt accepted, in seconds, measured against the receipt's
   * signed `timestamp_unix`. Default 900. `null` turns the age check off: the
   * loopback world serves one fixed, signed fixture and uses it.
   */
  receiptMaxAgeSeconds?: number | null;
  /**
   * Refuse a receipt whose leaf this state directory already accepted for an
   * earlier call. Default true; the loopback world turns it off for the same
   * reason as the age check.
   */
  refuseReceiptReplay?: boolean;
  /** Time allowed for each outbound request. Default two minutes. */
  requestTimeoutMs?: number;
  /**
   * Refuse a purchase identical to one whose payment left within this many
   * seconds (`duplicate_purchase`). Identical means the same method, full
   * target URL, request body, Idempotency-Key header, recipient, chain, asset
   * and amount: an agent that means to buy the same thing again sends a new
   * Idempotency-Key. Default 60; 0 turns the check off; at most 86400.
   */
  dedupeWindowSeconds?: number;
  now?: () => number;
}

export interface MandateRuntime {
  readonly mandate: Mandate;
  readonly stateDir: string;
  readonly ledger: DecisionLedger;
  readonly guard: ToolGuard;
  readonly agentKey: MandateKey | undefined;
  call(request: CallRequest): Promise<CallResult>;
  /**
   * Layers 1 to 3 for a request that another meter will price (the inference
   * route, metered by agent-killswitch on the shared spend ledger). Returns
   * the refusal, or null when the request may be forwarded. Either way the
   * decision goes on the ledger.
   */
  admit(tool: string, target: string): Refusal | null;
  /** Record a refusal made outside the pipeline (a request the sidecar cannot carry at all). */
  note(tool: string, target: string, code: string, detail: string): DecisionRecord;
  /** Layers 1 and 2 only, nothing written: is this runtime allowed to do anything at all right now? */
  precheck(): Refusal | null;
  status(): RuntimeStatus;
  counters(): RuntimeCounters;
  /** Write `.kill`. Everything stops until an operator removes it. */
  kill(reason?: string): void;
  /** Remove `.pause` and `.kill`. */
  resume(): { removed: string[] };
  close(): void;
}

interface CallContext {
  approved: PricedOffer;
  targetUrl: string;
  paymentRequests: number;
  refusal: Refusal | null;
  transport: typeof fetch;
  /**
   * Runs once, just before the request that carries the payment leaves:
   * the spend goes on the spend ledger and a `pending` line on the decision
   * ledger, so a process that dies mid-payment has already recorded it. A
   * refusal here stops the payment.
   */
  beforePayment: () => Refusal | null;
}

const PAYMENT_HEADERS = ["x-payment", "payment-signature"];
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
  // The runtime is the payer. An agent cannot hand it a payment to forward.
  ...PAYMENT_HEADERS,
]);
const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

/** An `Authorization: Payment ...` header is a payment credential (MPP). */
export function isPaymentAuthorization(value: string | null | undefined): boolean {
  return /^\s*payment(\s|$)/i.test(value ?? "");
}

function carriesPayment(headers: Headers): boolean {
  if (PAYMENT_HEADERS.some((h) => headers.has(h))) return true;
  return isPaymentAuthorization(headers.get("authorization"));
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** Text for the ledger and the agent: every URL in it is cut to scheme, host and path, as `publicUrl` does. */
function redactOrNull(text: string | null): string | null {
  return text === null ? null : redactUrls(text);
}

export function redactUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const cut = publicUrl(match);
    return cut === "(unparseable url)" ? "(url removed)" : cut;
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function requestHeaders(input: Parameters<typeof fetch>[0], init?: RequestInit): Headers {
  const headers = new Headers(typeof input === "object" && !(input instanceof URL) ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

/** The URL as it goes on the ledger and to the trust service: no query, no fragment, no credentials. */
export function publicUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}

/**
 * Wallets named as path segments of the target (`/v1/intel/trust/<wallet>`):
 * the subjects a paid trust lookup is about. The query string is not read,
 * so an agent cannot widen the receipt check with `?ref=<wallet>`.
 */
function walletsNamedIn(url: string): string[] {
  const found = new Set<string>();
  try {
    const u = new URL(url);
    for (const part of u.pathname.split("/")) {
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(part) || /^0x[0-9a-fA-F]{40}$/.test(part)) found.add(part);
    }
  } catch {
    // no wallets in a URL that does not parse
  }
  return [...found];
}

/**
 * Read a response body, at most `limit` bytes. A declared length over the
 * limit is refused before reading; otherwise the read stops (and the
 * request is cancelled) as soon as the running total passes the limit, so
 * an oversized body is never held in memory.
 */
export async function readCapped(resp: Response, limit: number = MAX_BODY_BYTES): Promise<Uint8Array> {
  const tooLarge = (): Error => new Error(`response body is larger than ${limit} bytes`);
  const declared = resp.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > limit) {
    await resp.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (resp.body === null) return new Uint8Array(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function jsonBody(doc: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}

function sameRecipient(a: string, b: string): boolean {
  return a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const openDirs = new Set<string>();

/** One runtime per state directory: budgets held in memory are only whole when one process holds them. */
function takeLock(stateDir: string): () => void {
  const lockPath = path.join(stateDir, STATE_FILES.lock);
  if (openDirs.has(stateDir)) throw new Error(`state directory ${stateDir} is already open in this process`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      openDirs.add(stateDir);
      return () => {
        openDirs.delete(stateDir);
        try {
          if (fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockPath);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number(fs.readFileSync(lockPath, "utf8").trim());
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && pidAlive(holder)) {
        throw new Error(`state directory ${stateDir} is in use by process ${holder}`);
      }
      // The holder is gone (or it was this process, which holds no open runtime here): the lock is stale.
      fs.unlinkSync(lockPath);
    }
  }
  throw new Error(`could not lock state directory ${stateDir}`);
}

function readSeenLeaves(file: string): Set<string> {
  try {
    return new Set(
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw err;
  }
}

/** `pending` lines that no later line answers: payments that left while a process died. */
function unresolvedPayments(ledger: DecisionLedger): DecisionRecord[] {
  const rows = ledger.tail(Number.MAX_SAFE_INTEGER);
  const answered = new Set(rows.filter((r) => typeof r.ref === "number").map((r) => r.ref as number));
  return rows.filter((r) => r.outcome === "pending" && !answered.has(r.seq));
}

function replayCounters(ledger: DecisionLedger): RuntimeCounters {
  const counters: RuntimeCounters = { decisions: 0, refusals: 0, settled: 0, free: 0, violations: 0, errors: 0, settledMicro: 0n, signatures: 0 };
  for (const row of ledger.tail(Number.MAX_SAFE_INTEGER)) tally(counters, row);
  return counters;
}

function usdStringToMicro(value: string | null): bigint {
  if (value === null) return 0n;
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6));
}

function tally(counters: RuntimeCounters, row: DecisionRecord): void {
  // A pending line is answered by the call's own outcome line (or by the recovery line written at start).
  if (row.outcome === "control" || row.outcome === "pending") return;
  counters.decisions += 1;
  counters.signatures += row.signatures;
  if (row.outcome === "refused") counters.refusals += 1;
  else if (row.outcome === "free" || row.outcome === "forwarded") counters.free += 1;
  else if (row.outcome === "settled") counters.settled += 1;
  else if (row.outcome === "violation") counters.violations += 1;
  else counters.errors += 1;
  if (row.outcome === "settled" || row.outcome === "violation") counters.settledMicro += usdStringToMicro(row.settledUsd);
}

function sha256Hex(bytes: Uint8Array | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * The purchase a paid call makes, as one hash: what is asked for (method,
 * full target URL with its query, request body, the agent's Idempotency-Key)
 * and what would be paid (recipient, chain, asset, amount). Only the hash goes
 * on the ledger, so a query string never does.
 */
/** JSON with object keys sorted at every depth, so equal values give equal text. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${sortedJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The `_meta` member an MCP client sets to buy the same tool call again on purpose. */
export const MCP_IDEMPOTENCY_META = "twzrd/idempotency-key";

/**
 * What a call buys, as the dedupe sees it. Over MCP the body is a JSON-RPC
 * message whose `id` and `_meta` change on every retry, so a `tools/call`
 * is reduced to its tool name and arguments; its idempotency key is
 * `params._meta["twzrd/idempotency-key"]`, since MCP has no request headers.
 */
function purchasedBody(request: Pick<CallRequest, "tool" | "headers" | "body">): { digest: string; idempotencyKey: string | null } {
  let idempotencyKey: string | null = null;
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (name.toLowerCase() === "idempotency-key") idempotencyKey = value;
  }
  const body = request.body && request.body.length > 0 ? request.body : new Uint8Array(0);
  if (request.tool?.startsWith("mcp:")) {
    try {
      const message = JSON.parse(Buffer.from(body).toString("utf8")) as { method?: unknown; params?: { name?: unknown; arguments?: unknown; _meta?: Record<string, unknown> } };
      if (message && message.method === "tools/call" && message.params && typeof message.params === "object") {
        const meta = message.params._meta?.[MCP_IDEMPOTENCY_META];
        return {
          digest: sha256Hex(sortedJson(["tools/call", message.params.name ?? null, message.params.arguments ?? null])),
          idempotencyKey: typeof meta === "string" ? meta : null,
        };
      }
    } catch {
      // Not JSON: hash the bytes as they are.
    }
  }
  return { digest: sha256Hex(body), idempotencyKey };
}

export function purchaseKey(request: Pick<CallRequest, "tool" | "method" | "headers" | "body">, target: URL, offer: Pick<PricedOffer, "payTo" | "caip2" | "asset" | "amountMicro">): string {
  const { digest, idempotencyKey } = purchasedBody(request);
  return sha256Hex(
    JSON.stringify([
      "twzrd.mandate.purchase.v1",
      (request.method ?? "GET").toUpperCase(),
      target.href,
      digest,
      idempotencyKey,
      offer.payTo,
      offer.caip2,
      offer.asset,
      offer.amountMicro.toString(),
    ]),
  );
}

/** Open the runtime for a verified mandate. Throws when the state directory cannot be used. */
export function createMandateRuntime(options: MandateRuntimeOptions): MandateRuntime {
  const { mandate } = options;
  const clock = options.now ?? Date.now;
  if (options.agentKey && options.agentKey.publicKey !== mandate.agent) {
    throw new Error("the agent key given to the runtime is not the agent this mandate names");
  }
  const stateDir = path.resolve(options.stateDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const release = takeLock(stateDir);

  const killFile = path.join(stateDir, STATE_FILES.kill);
  const pauseFile = path.join(stateDir, STATE_FILES.pause);
  const limits = mandateLimitsMicro(mandate);
  // A violation pause lasts until the mandate ends: only `resume` (with the control token) lifts it sooner.
  const tripPauseMs = options.tripPauseMs ?? Math.max(MIN_TRIP_PAUSE_MS, options.expiresAtMs - clock());
  const receiptMaxAgeSeconds =
    options.receiptMaxAgeSeconds === undefined ? DEFAULT_RECEIPT_MAX_AGE_SECONDS : options.receiptMaxAgeSeconds;
  const refuseReceiptReplay = options.refuseReceiptReplay ?? true;
  const dedupeWindowSeconds = options.dedupeWindowSeconds ?? DEFAULT_DEDUPE_WINDOW_SECONDS;
  if (!Number.isInteger(dedupeWindowSeconds) || dedupeWindowSeconds < 0 || dedupeWindowSeconds > MAX_DEDUPE_WINDOW_SECONDS) {
    throw new Error(`dedupeWindowSeconds must be a whole number from 0 to ${MAX_DEDUPE_WINDOW_SECONDS}`);
  }
  const dedupeWindowMs = dedupeWindowSeconds * 1000;
  const trustScreenOff = mandate.trustScreen === "off";
  const receiptLeavesPath = path.join(stateDir, RECEIPT_LEAVES_FILE);
  const baseFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const intelBase = (options.intelBase ?? "https://intel.twzrd.xyz").replace(/\/+$/, "");

  let ledger: DecisionLedger;
  let guard: ToolGuard;
  let seenLeaves: Set<string>;
  try {
    ledger = openDecisionLedger(path.join(stateDir, STATE_FILES.decisionLedger), mandate.mandateId, clock);
    const agreed = ledgerAgreesWithHeartbeat(ledger, path.join(stateDir, STATE_FILES.heartbeat));
    if (!agreed.ok) throw new Error(`refusing to open ${stateDir}: ${agreed.detail}`);
    seenLeaves = readSeenLeaves(receiptLeavesPath);
    guard = createToolGuard({
      ledgerPath: path.join(stateDir, STATE_FILES.toolLedger),
      killFilePath: killFile,
      pauseFilePath: pauseFile,
      allowedTools: mandate.allowedTools,
      maxCostPerCallUsd: Number(limits.perCall) / MICRO,
      maxUsdPerHour: Number(limits.hourly) / MICRO,
      maxUsdPerDay: Number(limits.daily) / MICRO,
      // The guard bounds its own trip pause at one day; the runtime's pause() writes the full length.
      tripPauseMs: Math.min(GUARD_MAX_TRIP_PAUSE_MS, Math.max(1000, Math.round(tripPauseMs))),
    });
  } catch (err) {
    release();
    throw err;
  }
  const counters = replayCounters(ledger);
  // When each purchase last had a payment leave, from the pending lines: a
  // restart does not forget a payment that went out a moment ago.
  // An entry is in flight from its claim until its call ends; the window
  // then runs from the end of the call, and only the call that claimed an
  // entry may change it.
  type PurchaseClaim = { at: number; inFlight: boolean; owner: symbol | null };
  const recentPurchases = new Map<string, PurchaseClaim>();
  for (const row of ledger.tail(Number.MAX_SAFE_INTEGER)) {
    // pending: a payment left; settled/violation: the call that paid it ended (the window runs from there).
    if (!(row.outcome === "pending" || row.outcome === "settled" || row.outcome === "violation") || typeof row.dedupeKey !== "string") continue;
    const at = Date.parse(row.at);
    if (Number.isFinite(at) && at > (recentPurchases.get(row.dedupeKey)?.at ?? -Infinity)) recentPurchases.set(row.dedupeKey, { at, inFlight: false, owner: null });
  }

  function rememberLeaf(leaf: string): void {
    const fd = fs.openSync(receiptLeavesPath, "a", 0o600);
    try {
      fs.writeSync(fd, `${leaf}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    seenLeaves.add(leaf);
  }

  // A pending line no later line answers is a payment that left while the
  // process died. Its spend is already in the hour and day windows (it was
  // booked before the payment left); answer it on the ledger and pause, so an
  // operator looks before spending goes on.
  try {
    const orphans = unresolvedPayments(ledger);
    for (const orphan of orphans) {
      write({
        outcome: "violation",
        layer: null,
        code: "payment_unresolved",
        tool: orphan.tool,
        target: orphan.target,
        payTo: orphan.payTo,
        quotedUsd: orphan.quotedUsd,
        settledUsd: orphan.quotedUsd,
        signatures: orphan.signatures,
        receipt: null,
        inclusion: null,
        detail: "a payment left but the process stopped before its outcome was recorded; the signed amount is recorded and spending is paused",
        ref: orphan.seq,
      });
    }
    if (orphans.length > 0) pause(UNRESOLVED_PAUSE_REASON);
  } catch (err) {
    release();
    throw err;
  }

  // Every setting that decides whether a seller is paid is stated here, so an
  // environment variable on the host cannot loosen what the mandate says.
  const gateConfig = resolveConfig({
    intelBase,
    stateDir,
    fetch: baseFetch,
    preflightMinScore: mandate.minTrustScore,
    blockDecisions: ["block"],
    failOpen: false,
    gateOnCanSpend: false,
    refuseUnevaluated: true,
    refuseUncappedWarn: true,
    refuseWashFlagged: true,
    refuseWashUnknown: true,
    washMaxUsdc: null,
    unsupportedNetworkMode: "strict",
    tripPauseOnBlockMs: 0,
  });

  const callStore = new AsyncLocalStorage<CallContext>();

  /**
   * The only way a request leaves the payment path. It sends nothing but the
   * call's own target, lets one payment leave per call, and narrows every 402
   * to the single offer the pipeline approved.
   */
  const paymentTransport: typeof fetch = async (input, init) => {
    const ctx = callStore.getStore();
    if (!ctx) throw new TwzrdWashAbortError("mandate_no_call_context");
    const url = requestUrl(input);
    if (url !== ctx.targetUrl) {
      // The gate's paying fetch falls back to a paid routing service when the
      // origin fails. Under a mandate there is no fallback: one tool, one target.
      if (ctx.paymentRequests === 0) {
        ctx.refusal ??= { layer: null, code: "upstream_error", detail: "the paid request failed before any payment was sent; a mandate allows no fallback route" };
      }
      throw new TwzrdWashAbortError("mandate_off_target_request");
    }
    const headers = requestHeaders(input, init);
    if (carriesPayment(headers)) {
      if (ctx.paymentRequests >= 1) {
        ctx.refusal ??= { layer: null, code: "second_payment_refused", detail: "the payer tried to send a second payment for one call" };
        throw new TwzrdWashAbortError("mandate_second_payment_refused");
      }
      const stopped = stopNow();
      if (stopped) {
        ctx.refusal = stopped;
        throw new TwzrdWashAbortError(stopped.code);
      }
      const unrecorded = ctx.beforePayment();
      if (unrecorded) {
        ctx.refusal = unrecorded;
        throw new TwzrdWashAbortError(unrecorded.code);
      }
      ctx.paymentRequests += 1;
    }
    const resp = await ctx.transport(input, { ...init, redirect: "manual" });
    if (resp.status !== 402 || ctx.paymentRequests > 0) return resp;
    const body = await readCapped(resp);
    const read = readChallenge(resp.headers, body);
    if (!read.ok) {
      ctx.refusal = { layer: 6, code: read.code, detail: read.detail };
      throw new TwzrdWashAbortError(PAYMENT_REQUIRED_UNREADABLE);
    }
    for (const raw of read.challenge.accepts) {
      const offer = readOffer(raw);
      if (offer.ok && sameOffer(ctx.approved, offer.offer)) return narrowChallenge(resp, read.challenge, raw);
    }
    ctx.refusal = {
      layer: 6,
      code: "offer_changed_after_approval",
      detail: "the seller's second 402 no longer carries the offer that was approved",
    };
    throw new TwzrdWashAbortError("offer_changed_after_approval");
  };

  const wrapPay = options.wrapPay;
  const policyFetch: typeof fetch | null = wrapPay
    ? createTwzrdPolicyFetch({
        signer: createLocalDecisionSigner(),
        policy: {
          // With the trust screen off the gate asks the trust service nothing either.
          refuseWashFlagged: !trustScreenOff,
          maxAmountUsd: mandate.limits.maxPerCallUsd,
          dailyCeilingUsd: mandate.limits.dailyCeilingUsd,
          ...(mandate.blockedCounterparties?.length ? { blocklist: mandate.blockedCounterparties } : {}),
          ...(mandate.allowedCounterparties?.length ? { allowlist: mandate.allowedCounterparties } : {}),
        },
        mandate: {
          mandateId: mandate.mandateId,
          maxPerTransactionUsd: mandate.limits.maxPerCallUsd,
          ...(mandate.limits.monthlyCeilingUsd !== undefined ? { monthlyCeilingUsd: mandate.limits.monthlyCeilingUsd } : {}),
          ...(mandate.blockedCounterparties?.length ? { payeeBlocklist: mandate.blockedCounterparties } : {}),
          expiresAt: mandate.expiresAt,
        },
        ledger: createFileSpendLedger(path.join(stateDir, STATE_FILES.gateLedger)),
        fetch: baseFetch,
        rawFetch: paymentTransport,
        peekFetch: paymentTransport,
        wrapPay: (guarded) =>
          wrapPay(async (input, init) => {
            const resp = await guarded(input, init);
            if (resp.status !== 402) return resp;
            // Last look before the payer: the mandate is still in force, nothing has halted
            // spending, and this 402 is the one approved offer and nothing else.
            const ctx = callStore.getStore();
            const stopped = stopNow();
            if (stopped) {
              if (ctx) ctx.refusal = stopped;
              throw new TwzrdWashAbortError(stopped.code);
            }
            const read = readChallenge(resp.headers, new Uint8Array(await resp.clone().arrayBuffer()));
            const only = read.ok && read.challenge.accepts.length === 1 ? readOffer(read.challenge.accepts[0] as Record<string, unknown>) : null;
            if (!ctx || !only || !only.ok || !sameOffer(ctx.approved, only.offer)) {
              if (ctx) ctx.refusal ??= { layer: 6, code: "offer_changed_after_approval", detail: "the 402 handed to the payer is not the approved offer" };
              throw new TwzrdWashAbortError("offer_changed_after_approval");
            }
            if (ctx.paymentRequests > 0) throw new TwzrdWashAbortError("mandate_second_payment_refused");
            return resp;
          }),
        stateDir,
        killFilePath: killFile,
        pauseFilePath: pauseFile,
        intelBase,
        failOpen: false,
        refuseWashFlagged: !trustScreenOff,
        washMaxUsdc: null,
        topUrl: "http://mandate.invalid/top",
        routeUrl: "http://mandate.invalid/route",
        deliveryCapture: false,
      } as Parameters<typeof createTwzrdPolicyFetch>[0])
    : null;

  function haltNow(): Refusal | null {
    const state = readSentinelState({ stateDir, killFilePath: killFile, pauseFilePath: pauseFile, now: clock() });
    if (!state.active) return null;
    if (state.mode === "kill") return { layer: 2, code: "kill_switch", detail: `the kill file ${killFile} is present` };
    return { layer: 2, code: "payment_gate_halt", detail: `spending is paused (${state.reason})` };
  }

  /** Why no payment may be made right now, or null. Checked again at every step up to the payer. */
  function stopNow(): Refusal | null {
    if (clock() >= options.expiresAtMs) return { layer: 1, code: "mandate_expired", detail: `the mandate expired at ${mandate.expiresAt}` };
    return haltNow();
  }

  function pause(reason: string): void {
    try {
      const state = readSentinelState({ stateDir, killFilePath: killFile, pauseFilePath: pauseFile, now: clock() });
      if (state.active && state.mode !== "kill" && state.untilUnixMs !== null && state.untilUnixMs >= clock() + tripPauseMs) return;
      writePauseSentinel(pauseFile, { ttlMs: tripPauseMs, reason, now: clock() });
    } catch {
      // A pause that cannot be written must still stop spending: fall back to the kill file.
      try {
        fs.writeFileSync(killFile, JSON.stringify({ at: new Date(clock()).toISOString(), reason: `${reason}; the pause file could not be written` }));
      } catch {
        // nothing more can be done from here; the violation is on the ledger
      }
    }
  }

  function write(input: DecisionInput): DecisionRecord {
    const record = ledger.append(input);
    tally(counters, record);
    return record;
  }

  interface Finish {
    outcome: CallOutcome;
    request: CallRequest;
    status: number;
    headers?: Headers;
    body?: Uint8Array;
    refusal?: Refusal | null;
    signatures?: number;
    offer?: PricedOffer | null;
    settledMicro?: bigint | null;
    receipt?: ReceiptCheck | null;
    inclusion?: InclusionCheck | null;
    detail?: string | null;
    /** The seq of this call's `pending` line, when a payment left. */
    ref?: number | null;
    /** The purchase's dedupe key, once an offer was chosen. */
    dedupeKey?: string;
    /** The bytes a signed payment bought, hashed onto the outcome line. */
    responseBody?: Uint8Array;
  }

  function finish(f: Finish): CallResult {
    const signatures = f.signatures ?? 0;
    const refusal = f.refusal ?? null;
    const quotedUsd = f.offer ? microToUsd(f.offer.amountMicro) : null;
    const settledUsd = f.settledMicro === undefined || f.settledMicro === null ? null : microToUsd(f.settledMicro);
    const record = write({
      outcome: f.outcome === "error" ? "refused" : f.outcome,
      layer: refusal?.layer ?? null,
      code: refusal?.code ?? (f.outcome === "error" ? "upstream_error" : null),
      tool: f.request.tool,
      target: publicUrl(f.request.url),
      payTo: f.offer?.payTo ?? null,
      quotedUsd,
      settledUsd,
      signatures,
      receipt: f.receipt?.status ?? null,
      inclusion: f.inclusion?.status ?? null,
      // Error text can quote the target with its credentials and query: cut every URL down.
      detail: redactOrNull(refusal?.detail ?? f.detail ?? null),
      ref: f.ref ?? null,
      ...(f.dedupeKey !== undefined ? { dedupeKey: f.dedupeKey } : {}),
      ...(signatures > 0 && f.responseBody !== undefined ? { responseSha256: sha256Hex(f.responseBody) } : {}),
    });
    const headers = new Headers();
    f.headers?.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.has(key)) headers.set(key, value);
    });
    let body = f.body;
    const delivered = body !== undefined;
    if (body === undefined) {
      headers.set("content-type", "application/json");
      body = jsonBody({
        error: {
          type: f.outcome === "refused" ? "twzrd_mandate_refused" : f.outcome === "violation" ? "twzrd_mandate_violation" : "twzrd_mandate_error",
          layer: refusal?.layer ?? null,
          code: record.code,
          detail: record.detail,
          signatures,
          mandateId: mandate.mandateId,
          ledgerSeq: record.seq,
        },
      });
    }
    headers.set("x-twzrd-mandate", f.outcome);
    headers.set("x-twzrd-mandate-seq", String(record.seq));
    if (record.code) headers.set("x-twzrd-mandate-code", record.code);
    return {
      outcome: f.outcome,
      status: f.status,
      headers,
      body,
      delivered,
      refusal,
      signatures,
      quotedUsd,
      settledUsd,
      payTo: f.offer?.payTo ?? null,
      receipt: f.receipt ?? null,
      inclusion: f.inclusion ?? null,
      record,
    };
  }

  function refusalFromAbort(err: unknown): Refusal | null {
    if (err instanceof TwzrdPolicyAbortError) {
      const codes = new Set((err.decision as { reasonCodes?: string[] }).reasonCodes ?? []);
      const detail = `payment gate: ${[...codes].join(", ") || err.message}`;
      if (codes.has("MANDATE_EXPIRED")) return { layer: 1, code: "mandate_expired", detail };
      if (codes.has("twzrd_kill_switch")) return { layer: 2, code: "kill_switch", detail };
      if (codes.has("twzrd_payment_paused") || codes.has("twzrd_pause_corrupt")) return { layer: 2, code: "payment_gate_halt", detail };
      if (codes.has("MANDATE_MONTHLY_CEILING")) return { layer: 4, code: "monthly_ceiling_exceeded", detail };
      if (codes.has("POLICY_DAILY_CEILING")) return { layer: 4, code: "budget_exceeded", detail };
      if (codes.has("POLICY_MAX_AMOUNT") || codes.has("MANDATE_MAX_PER_TX")) return { layer: 4, code: "per_request_cap", detail };
      if (codes.has("POLICY_BLOCKLIST") || codes.has("MANDATE_PAYEE_BLOCKED")) return { layer: 5, code: "counterparty_blocked", detail };
      if (codes.has("POLICY_NOT_ALLOWLISTED")) return { layer: 5, code: "counterparty_not_allowed", detail };
      return { layer: 4, code: "payment_gate_refused", detail };
    }
    if (err instanceof TwzrdWashAbortError) {
      const halt = haltNow();
      if (halt) return halt;
      if (err.message.includes(PAYMENT_REQUIRED_UNREADABLE)) {
        return { layer: 6, code: "payment_required_unreadable", detail: "the payment gate could not read the 402" };
      }
      return { layer: 5, code: "trust_gate_refused", detail: `payment gate: ${err.message}` };
    }
    return null;
  }

  function readBill(headers: Headers, signedMicro: bigint): { micro: bigint | null; detail: string } {
    const header = headers.get("payment-response") ?? headers.get("x-payment-response");
    if (header === null) return { micro: signedMicro, detail: "no settlement header; the signed amount is recorded" };
    // What the seller reports is checked against what was signed, never recorded in its place.
    const text = strictBase64ToUtf8(header);
    let doc: unknown;
    try {
      doc = text === null ? undefined : JSON.parse(text);
    } catch {
      doc = undefined;
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { micro: null, detail: "the settlement header is not readable" };
    const settled = doc as Record<string, unknown>;
    if (settled.success === false) return { micro: null, detail: "the seller reports the settlement failed" };
    if (settled.amount === undefined) return { micro: signedMicro, detail: "the settlement header names no amount; the signed amount is recorded" };
    if (typeof settled.amount !== "string" || !/^(0|[1-9][0-9]{0,17})$/.test(settled.amount)) {
      return { micro: null, detail: "the settlement header's amount is not readable" };
    }
    return { micro: BigInt(settled.amount), detail: "the settlement header names the signed amount" };
  }

  function buildInit(request: CallRequest): RequestInit {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      const name = key.toLowerCase();
      if (STRIP_REQUEST_HEADERS.has(name)) continue;
      // The runtime is the payer: an agent's own `Authorization: Payment ...` is dropped like `x-payment`.
      if (name === "authorization" && isPaymentAuthorization(value)) continue;
      headers.set(key, value);
    }
    const method = (request.method ?? "GET").toUpperCase();
    const init: RequestInit = { method, headers, redirect: "manual", signal: AbortSignal.timeout(options.requestTimeoutMs ?? 120_000) };
    if (request.body && request.body.length > 0 && method !== "GET" && method !== "HEAD") init.body = Buffer.from(request.body);
    return init;
  }

  async function call(request: CallRequest): Promise<CallResult> {
    const requestId = request.requestId ?? crypto.randomUUID();
    const transport = request.transport ?? baseFetch;

    // Layer 1: the mandate is still in force.
    if (clock() >= options.expiresAtMs) {
      return finish({ outcome: "refused", request, status: 403, refusal: { layer: 1, code: "mandate_expired", detail: `the mandate expired at ${mandate.expiresAt}` } });
    }
    // Layer 2: the kill file stops everything, paid or free.
    const halted = haltNow();
    if (halted?.code === "kill_switch") return finish({ outcome: "refused", request, status: 403, refusal: halted });
    // Layer 3: the tool is on the allow-list.
    if (!mandate.allowedTools.includes(request.tool)) {
      return finish({
        outcome: "refused",
        request,
        status: 403,
        refusal: { layer: 3, code: "tool_not_allowed", detail: `tool "${request.tool}" is not in the mandate's allowedTools` },
      });
    }
    if (request.body && request.body.length > MAX_BODY_BYTES) {
      return finish({ outcome: "error", request, status: 413, refusal: { layer: null, code: "request_too_large", detail: "the request body is too large to replay" } });
    }
    let target: URL;
    try {
      target = new URL(request.url);
      // A custom transport names its own target; the runtime's own fetch only speaks HTTP.
      if (!request.transport && target.protocol !== "http:" && target.protocol !== "https:") throw new Error("scheme");
    } catch {
      return finish({ outcome: "error", request, status: 400, refusal: { layer: null, code: "bad_target", detail: "the target is not an http or https URL" } });
    }
    if (target.username !== "" || target.password !== "") {
      return finish({ outcome: "error", request, status: 400, refusal: { layer: null, code: "bad_target", detail: "the target URL carries credentials; send them in a header instead" } });
    }

    // The unpaid request: the price, or the answer if the call is free.
    const init = buildInit(request);
    let first: Response;
    let firstBody: Uint8Array;
    try {
      first = await transport(target.href, init);
      firstBody = await readCapped(first);
    } catch (err) {
      return finish({ outcome: "error", request, status: 502, refusal: { layer: null, code: "upstream_error", detail: `the target could not be reached: ${(err as Error).message}` } });
    }
    if (first.status !== 402) {
      return finish({ outcome: "free", request, status: first.status, headers: first.headers, body: firstBody });
    }

    // From here on the call costs money.
    if (halted) return finish({ outcome: "refused", request, status: 403, refusal: halted });
    const read = readChallenge(first.headers, firstBody);
    if (!read.ok) return finish({ outcome: "refused", request, status: 403, refusal: { layer: 6, code: read.code, detail: read.detail } });

    const choice = chooseOffer(read.challenge);
    if (!choice.ok) return finish({ outcome: "refused", request, status: 403, refusal: choice.refusal, offer: choice.offer });
    const offer = choice.offer;
    if (!policyFetch) {
      return finish({
        outcome: "refused",
        request,
        status: 403,
        offer,
        refusal: { layer: 6, code: "no_payer_configured", detail: "this runtime has no pay module, so it cannot settle a 402" },
      });
    }

    // Layer 4: the same purchase, paid a moment ago, is not paid again.
    // From this check to the claim below nothing awaits, so two identical
    // calls in flight together cannot both pass it.
    const dedupeKey = purchaseKey(request, target, offer);
    if (dedupeWindowMs > 0) {
      const last = recentPurchases.get(dedupeKey);
      // |age|: a clock stepped back blocks for at most one window, not the step plus a window.
      const age = last === undefined ? Infinity : clock() - last.at;
      if (last !== undefined && (last.inFlight || Math.abs(age) < dedupeWindowMs)) {
        const ago = Math.max(0, Math.floor(age / 1000));
        const said = last.inFlight
          ? "an identical purchase is in flight"
          : `the same purchase had a payment end ${ago} s ago (window ${dedupeWindowSeconds} s)`;
        return finish({
          outcome: "refused",
          request,
          status: 403,
          offer,
          dedupeKey,
          refusal: {
            layer: 4,
            code: "duplicate_purchase",
            detail: `${said}; to buy it again send a new Idempotency-Key header (over MCP, params._meta["${MCP_IDEMPOTENCY_META}"])`,
          },
        });
      }
    }

    // Layers 2 to 4, atomically: kill, pause, allow-list, per-call cap, hour and day budget. Holds the worst case.
    const worstCaseUsd = Number(offer.amountMicro) / MICRO;
    const decision = guard.authorize({ tool: request.tool, worstCaseUsd, requestId });
    if (!decision.allowed || decision.hold === null) {
      const code = decision.code ?? "budget_exceeded";
      const layer = code === "kill_switch" || code === "payment_gate_halt" ? 2 : code === "tool_not_allowed" ? 3 : code === "unbounded_cost" ? 6 : 4;
      return finish({ outcome: "refused", request, status: 403, offer, dedupeKey, refusal: { layer, code, detail: decision.message } });
    }
    // Claimed now; given back in `finally` if no payment leaves.
    const priorPurchase = recentPurchases.get(dedupeKey);
    const claimOwner = Symbol("purchase");
    if (dedupeWindowMs > 0) recentPurchases.set(dedupeKey, { at: clock(), inFlight: true, owner: claimOwner });
    const hold: ToolHold = decision.hold;
    let resp: Response | undefined;
    let respBody: Uint8Array | undefined;
    let thrown: unknown;
    let held = true;
    let pending: DecisionRecord | null = null;
    const releaseHold = (): void => {
      if (held) {
        held = false;
        hold.release();
      }
    };
    const quotedUsd = microToUsd(offer.amountMicro);
    const beforePayment = (): Refusal | null => {
      try {
        held = false;
        // The signed amount, booked in the hour and day windows before the payment can leave.
        hold.settle(worstCaseUsd);
      } catch (err) {
        // Nothing was booked, so the hold must not stay reserved either.
        try {
          hold.release();
        } catch {
          // already settled or released; nothing is held
        }
        pause(SPEND_RECORD_PAUSE_REASON);
        return { layer: null, code: "spend_record_failed", detail: `the spend could not be recorded, so nothing was paid: ${(err as Error).message}` };
      }
      try {
        pending = write({
          outcome: "pending",
          layer: null,
          code: "payment_sent",
          tool: request.tool,
          target: publicUrl(target.href),
          payTo: offer.payTo,
          quotedUsd,
          settledUsd: quotedUsd,
          signatures: 1,
          receipt: null,
          inclusion: null,
          detail: "a payment is leaving; this call's outcome follows on a later line",
          dedupeKey,
        });
      } catch (err) {
        pause(SPEND_RECORD_PAUSE_REASON);
        return { layer: null, code: "spend_record_failed", detail: `the decision ledger could not be written, so nothing was paid: ${(err as Error).message}` };
      }
      return null;
    };
    const ctx: CallContext = { approved: offer, targetUrl: target.href, paymentRequests: 0, refusal: null, transport, beforePayment };
    try {
      // Layer 5: the trust screen. A free preflight; nothing is signed for it.
      // A mandate signed with trustScreen "off" makes no lookup; the chain and
      // counterparty lists were already applied when the offer was chosen.
      if (!trustScreenOff) {
        let approval;
        try {
          approval = await twzrdApprovePayment(
            { sellerWallet: offer.payTo, priceUsdc: worstCaseUsd, chain: offer.caip2, asset: offer.asset, resourceUrl: publicUrl(target.href) },
            gateConfig,
          );
        } catch (err) {
          releaseHold();
          return finish({
            dedupeKey,
            outcome: "refused",
            request,
            status: 403,
            offer,
            refusal: stopNow() ?? { layer: 5, code: "trust_gate_refused", detail: `the trust check could not run: ${(err as Error).message}` },
          });
        }
        // The lookup took time: the mandate may have expired or been halted while it ran.
        const stoppedDuringLookup = stopNow();
        if (stoppedDuringLookup) {
          releaseHold();
          return finish({ dedupeKey, outcome: "refused", request, status: 403, offer, refusal: stoppedDuringLookup });
        }
        if (!approval.approved) {
          releaseHold();
          return finish({ dedupeKey, outcome: "refused", request, status: 403, offer, refusal: { layer: 5, code: "trust_gate_refused", detail: approval.reason } });
        }
      }
      // Layers 4 and 6 again inside the paying fetch, then the payer.
      try {
        resp = await callStore.run(ctx, () => policyFetch(target.href, init));
        respBody = await readCapped(resp);
      } catch (err) {
        thrown = err;
      }

      if (ctx.paymentRequests === 0) {
        // Nothing carrying a payment left this process.
        releaseHold();
        if (thrown !== undefined) {
          const refusal = ctx.refusal ?? refusalFromAbort(thrown);
          if (refusal && refusal.layer !== null) return finish({ dedupeKey, outcome: "refused", request, status: 403, offer, refusal });
          return finish({
            dedupeKey,
            outcome: "error",
            request,
            status: 502,
            offer,
            refusal: refusal ?? { layer: null, code: "upstream_error", detail: `the paid request failed before any payment was sent: ${(thrown as Error).message}` },
          });
        }
        if ((resp as Response).status === 402) {
          return finish({ dedupeKey, outcome: "refused", request, status: 403, offer, refusal: { layer: 6, code: "payment_not_made", detail: "the pay module returned the 402 without paying it" } });
        }
        return finish({ dedupeKey, outcome: "free", request, status: (resp as Response).status, headers: (resp as Response).headers, body: respBody as Uint8Array });
      }

      // A payment left, and its spend was booked before it did (beforePayment). What is
      // recorded is the signed amount, whatever the seller reports about it.
      const signatures = ctx.paymentRequests;
      const ref = (pending as DecisionRecord | null)?.seq ?? null;
      const failed = thrown !== undefined || !(resp as Response).ok;
      const settledMicro = offer.amountMicro;
      if (failed) {
        pause(SETTLEMENT_PAUSE_REASON);
        const why = thrown !== undefined ? `the paid request failed: ${(thrown as Error).message}` : `the seller answered ${(resp as Response).status} to a signed payment`;
        return finish({ dedupeKey, responseBody: respBody,
          outcome: "violation",
          request,
          status: 502,
          offer,
          signatures,
          settledMicro,
          ref,
          refusal: { layer: null, code: "paid_call_failed", detail: `${why}; the signed amount is recorded and spending is paused` },
        });
      }
      const bill = readBill((resp as Response).headers, offer.amountMicro);
      let tripReason: string | null = null;
      if (bill.micro === null) {
        tripReason = `${bill.detail}; the signed amount ${quotedUsd} USD is recorded`;
      } else if (bill.micro !== offer.amountMicro) {
        tripReason = `the seller reports ${microToUsd(bill.micro)} USD settled, but ${quotedUsd} USD was signed; the signed amount is recorded`;
      }
      const tripped = tripReason !== null;
      if (tripped) pause(SETTLEMENT_PAUSE_REASON);

      // Receipt and inclusion, under pinned keys.
      const paid = resp as Response;
      const paidBody = respBody as Uint8Array;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(paidBody));
      } catch {
        parsed = undefined;
      }
      const receipt = checkReceipt(findReceipt(parsed), {
        subjects: [offer.payTo, ...walletsNamedIn(target.href)],
        requireV7: mandate.requireV7Receipt,
        maxAgeSeconds: receiptMaxAgeSeconds,
        now: clock(),
        ...(refuseReceiptReplay ? { seenLeaves } : {}),
      });
      if (receipt.status === "verified" && receipt.leaf !== null && refuseReceiptReplay) {
        // Recorded before the response is handed back: the same receipt is refused next time, across restarts.
        try {
          rememberLeaf(receipt.leaf);
        } catch (err) {
          pause(SPEND_RECORD_PAUSE_REASON);
          return finish({ dedupeKey, responseBody: respBody,
            outcome: "violation",
            request,
            status: 502,
            offer,
            signatures,
            settledMicro,
            receipt,
            ref,
            refusal: { layer: null, code: "spend_record_failed", detail: `the receipt could not be recorded: ${(err as Error).message}; the response is withheld and spending is paused` },
          });
        }
      }
      let inclusion: InclusionCheck = { status: "not_checked", leafIndex: null, treeSize: null, detail: "not required" };
      const hasInlineProof = findInclusion(parsed) !== undefined;
      if (receipt.status === "verified" && receipt.leaf !== null && (mandate.requireMerkleInclusion || hasInlineProof)) {
        inclusion = await checkInclusion(parsed, receipt.leaf, {
          logBaseUrl: mandate.requireMerkleInclusion ? (options.logBaseUrl ?? intelBase) : undefined,
          fetchImpl: baseFetch,
        });
      }
      const receiptFailed = mandate.requireV7Receipt && receipt.status !== "verified";
      const inclusionFailed = mandate.requireMerkleInclusion && inclusion.status !== "proven";
      if (receiptFailed || inclusionFailed) {
        pause(RECEIPT_PAUSE_REASON);
        const code = receiptFailed ? (receipt.status === "absent" ? "receipt_missing" : "receipt_invalid") : "inclusion_unproven";
        const detail = receiptFailed ? receipt.detail : inclusion.detail;
        return finish({ dedupeKey, responseBody: respBody,
          outcome: "violation",
          request,
          status: 502,
          offer,
          signatures,
          settledMicro,
          receipt,
          inclusion,
          ref,
          refusal: { layer: null, code, detail: `${detail}; the response is withheld and spending is paused` },
        });
      }
      if (tripped) {
        return finish({ dedupeKey, responseBody: respBody,
          outcome: "violation",
          request,
          status: paid.status,
          headers: paid.headers,
          body: paidBody,
          offer,
          signatures,
          settledMicro,
          receipt,
          inclusion,
          ref,
          refusal: { layer: null, code: "settlement_tripped", detail: `${tripReason ?? bill.detail}; spending is paused` },
        });
      }
      return finish({ dedupeKey, responseBody: respBody,
        outcome: "settled",
        request,
        status: paid.status,
        headers: paid.headers,
        body: paidBody,
        offer,
        signatures,
        settledMicro,
        receipt,
        inclusion,
        ref,
        detail: bill.detail,
      });
    } finally {
      // A hold must never outlive its call.
      releaseHold();
      // No payment left: this call never bought anything, so it blocks nothing.
      // A payment left: the window runs from now, the end of the call.
      if (dedupeWindowMs > 0 && recentPurchases.get(dedupeKey)?.owner === claimOwner) {
        if (ctx.paymentRequests > 0) recentPurchases.set(dedupeKey, { at: clock(), inFlight: false, owner: claimOwner });
        else if (priorPurchase === undefined) recentPurchases.delete(dedupeKey);
        else recentPurchases.set(dedupeKey, priorPurchase);
      }
    }
  }

  type Choice = { ok: true; offer: PricedOffer } | { ok: false; refusal: Refusal; offer: PricedOffer | null };

  /** Pick the one offer this call may pay: the cheapest that the mandate allows. */
  function chooseOffer(challenge: X402Challenge): Choice {
    const eligible: PricedOffer[] = [];
    let firstFailure: { refusal: Refusal; offer: PricedOffer | null } | null = null;
    for (const raw of challenge.accepts) {
      const read = readOffer(raw);
      let refusal: Refusal | null = null;
      let offer: PricedOffer | null = null;
      if (!read.ok) {
        refusal = { layer: read.code === "chain_not_allowed" ? 5 : 6, code: read.code, detail: read.detail };
      } else {
        offer = read.offer;
        const payTo = offer.payTo;
        if (!mandate.allowedChains.includes(offer.chain)) {
          refusal = { layer: 5, code: "chain_not_allowed", detail: `the mandate does not allow payments on ${offer.chain}` };
        } else if ((mandate.blockedCounterparties ?? []).some((b) => sameRecipient(b, payTo))) {
          refusal = { layer: 5, code: "counterparty_blocked", detail: `recipient ${payTo} is on the mandate's blocked list` };
        } else if (mandate.allowedCounterparties?.length && !mandate.allowedCounterparties.some((a) => sameRecipient(a, payTo))) {
          refusal = { layer: 5, code: "counterparty_not_allowed", detail: `recipient ${payTo} is not on the mandate's allowed list` };
        } else if (offer.amountMicro > limits.perCall) {
          refusal = {
            layer: 4,
            code: "per_request_cap",
            detail: `the price ${microToUsd(offer.amountMicro)} USD is over the per-call cap ${microToUsd(limits.perCall)} USD`,
          };
        }
      }
      if (refusal === null && offer !== null) eligible.push(offer);
      else if (firstFailure === null && refusal !== null) firstFailure = { refusal, offer };
    }
    if (eligible.length === 0) {
      return { ok: false, ...(firstFailure ?? { refusal: { layer: 6, code: "payment_required_unreadable", detail: "the 402 lists no payment options" }, offer: null }) };
    }
    eligible.sort((a, b) => (a.amountMicro < b.amountMicro ? -1 : a.amountMicro > b.amountMicro ? 1 : 0));
    return { ok: true, offer: eligible[0] as PricedOffer };
  }

  function status(): RuntimeStatus {
    const spend = guard.spend();
    const hourMicro = BigInt(Math.round(spend.hourUsd * MICRO));
    const dayMicro = BigInt(Math.round(spend.dayUsd * MICRO));
    const left = (cap: bigint, used: bigint): string => microToUsd(cap > used ? cap - used : 0n);
    const state = readSentinelState({ stateDir, killFilePath: killFile, pauseFilePath: pauseFile, now: clock() });
    return {
      schema: "twzrd.mandate.status.v1",
      mandate: {
        mandateId: mandate.mandateId,
        issuerMode: mandate.issuerMode,
        issuer: mandate.issuer,
        agent: mandate.agent,
        issuedAt: mandate.issuedAt,
        expiresAt: mandate.expiresAt,
        expired: clock() >= options.expiresAtMs,
        task: mandate.task ?? null,
        limits: mandate.limits,
        allowedChains: [...mandate.allowedChains],
        minTrustScore: mandate.minTrustScore,
        trustScreen: trustScreenOff ? "off" : "required",
        allowedTools: [...mandate.allowedTools],
        requireV7Receipt: mandate.requireV7Receipt,
        requireMerkleInclusion: mandate.requireMerkleInclusion,
      },
      halt: state.active
        ? { active: true, mode: state.mode, reason: state.reason, untilUnixMs: state.untilUnixMs }
        : { active: false, mode: null, reason: null, untilUnixMs: null },
      spend: {
        hourUsd: microToUsd(hourMicro),
        dayUsd: microToUsd(dayMicro),
        remainingHourUsd: left(limits.hourly, hourMicro),
        remainingDayUsd: left(limits.daily, dayMicro),
      },
      counters: {
        decisions: counters.decisions,
        refusals: counters.refusals,
        settled: counters.settled,
        free: counters.free,
        violations: counters.violations,
        errors: counters.errors,
        settledUsd: microToUsd(counters.settledMicro),
        signatures: counters.signatures,
      },
      ledger: { path: ledger.filePath, lines: ledger.count(), head: ledger.head() },
      dedupeWindowSeconds,
      payer: policyFetch ? "configured" : "none",
      stateDir,
    };
  }

  function admit(tool: string, targetUrl: string): Refusal | null {
    let refusal: Refusal | null = null;
    if (clock() >= options.expiresAtMs) {
      refusal = { layer: 1, code: "mandate_expired", detail: `the mandate expired at ${mandate.expiresAt}` };
    } else {
      refusal = haltNow();
      if (refusal === null && !mandate.allowedTools.includes(tool)) {
        refusal = { layer: 3, code: "tool_not_allowed", detail: `tool "${tool}" is not in the mandate's allowedTools` };
      }
    }
    write({
      outcome: refusal ? "refused" : "forwarded",
      layer: refusal?.layer ?? null,
      code: refusal?.code ?? null,
      tool,
      target: publicUrl(targetUrl),
      payTo: null,
      quotedUsd: null,
      settledUsd: null,
      signatures: 0,
      receipt: null,
      inclusion: null,
      detail: refusal?.detail ?? "forwarded; metered by agent-killswitch on the shared spend ledger",
    });
    return refusal;
  }

  function control(code: string, detail: string): void {
    ledger.append({
      outcome: "control",
      layer: null,
      code,
      tool: null,
      target: null,
      payTo: null,
      quotedUsd: null,
      settledUsd: null,
      signatures: 0,
      receipt: null,
      inclusion: null,
      detail,
    });
  }

  return {
    mandate,
    stateDir,
    ledger,
    guard,
    agentKey: options.agentKey,
    call,
    admit,
    note(tool: string, targetUrl: string, code: string, detail: string): DecisionRecord {
      return write({
        outcome: "refused",
        layer: null,
        code,
        tool,
        target: publicUrl(targetUrl),
        payTo: null,
        quotedUsd: null,
        settledUsd: null,
        signatures: 0,
        receipt: null,
        inclusion: null,
        detail,
      });
    },
    precheck(): Refusal | null {
      if (clock() >= options.expiresAtMs) return { layer: 1, code: "mandate_expired", detail: `the mandate expired at ${mandate.expiresAt}` };
      return haltNow();
    },
    status,
    counters: () => ({ ...counters }),
    kill(reason = "operator"): void {
      fs.writeFileSync(killFile, `${JSON.stringify({ at: new Date(clock()).toISOString(), reason: reason.slice(0, 200) })}\n`);
      control("kill", `kill file written (${reason.slice(0, 200)})`);
    },
    resume(): { removed: string[] } {
      const removed: string[] = [];
      for (const [name, file] of [
        [STATE_FILES.pause, pauseFile],
        [STATE_FILES.kill, killFile],
      ] as const) {
        try {
          fs.unlinkSync(file);
          removed.push(name);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      control("resume", removed.length ? `removed ${removed.join(", ")}` : "nothing to remove");
      return { removed };
    },
    close(): void {
      release();
    },
  };
}
