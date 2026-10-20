/**
 * Fulfillment record: after a paid call returns, one local row saying who was
 * paid, the settlement transaction, who the seller says served the request, and
 * whether the seller says the job became ready.
 *
 * Local only. Nothing here makes a network call, and nothing is sent to TWZRD.
 * It records what the payment headers and the seller's own response say; it
 * does not verify delivery. `paid_to` and `tx` come from the payment the client
 * signed and the facilitator's PAYMENT-RESPONSE, and can be checked on chain.
 * `served_by`, `ready` and `failover_hops` are the seller's claims.
 *
 * Fields read from the seller's JSON body (nothing else is copied):
 *   provider        GPU-job sellers (for example Kilawatt Cloud): a node label,
 *                   not a supplier or wallet, so it is never compared to paid_to
 *   model           OpenAI-compatible responses; compared to the request's model
 *   failover_hops   integer (or the older failover_from array, counted)
 *   ready, status   job readiness; ready:false with a non-terminal status (for
 *                   example "provisioning") is pending, not a failure
 *   job_id
 *   payment.transaction_hash / transaction_hash   compared to PAYMENT-RESPONSE
 *
 * A wallet behind a local proxy that pays internally (the proxy returns 200 and
 * never exposes the 402) gives the paying fetch no payment header to see, so no
 * row is written; call `buildFulfillmentRecord` yourself with the request and
 * response bodies to compare models there.
 */
import { mkdirSync } from "node:fs";
import { appendFile, open, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveRequirementFields } from "./payto.js";

export const FULFILLMENT_RECORD_SCHEMA = "twzrd.fulfillment.v1";

/** Largest JSON response body read for fulfillment fields; larger bodies record headers only. */
export const FULFILLMENT_MAX_BODY_BYTES = 1024 * 1024;

export type FulfillmentVerdict = "match" | "mismatch" | "pending" | "not_reported";

export type FulfillmentReason =
  /** The seller reports a terminal status (failed, cancelled, refunded, ...) and ready is not true. */
  | "not_ready"
  /** The seller served a different model from the one requested. */
  | "model_substituted"
  /** The transaction in the seller's body is not the one in PAYMENT-RESPONSE. */
  | "tx_disagrees"
  /** PAYMENT-RESPONSE reports success: false. */
  | "settle_failed"
  /** PAYMENT-RESPONSE reports a settled payment, but the response status is not 2xx. */
  | "paid_http_error";

export type FulfillmentRecord = {
  schema: typeof FULFILLMENT_RECORD_SCHEMA;
  at_unix_ms: number;
  /** Origin of the paid resource only; paths and query strings are never kept. */
  resource_origin: string | null;
  http_status: number;
  /** Who was paid: payTo of the requirement the client signed. */
  paid_to: string | null;
  network: string | null;
  /** Signed amount in the asset's base units. */
  amount_atomic: string | null;
  /** Settlement transaction from PAYMENT-RESPONSE, else from the seller's body. */
  tx: string | null;
  /** PAYMENT-RESPONSE success flag; null when the header was absent. */
  settled: boolean | null;
  /** Who the seller says served: its `provider` label or its `model`. */
  served_by: string | null;
  served_by_field: "provider" | "model" | null;
  requested_model: string | null;
  failover_hops: number | null;
  ready: boolean | null;
  job_status: string | null;
  job_id: string | null;
  verdict: FulfillmentVerdict;
  reasons: FulfillmentReason[];
};

export type FulfillmentInput = {
  resource?: string;
  httpStatus: number;
  /** The PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1) header the client sent. */
  paymentHeader?: string | null;
  /** The PAYMENT-RESPONSE (v2) or X-PAYMENT-RESPONSE (v1) header returned. */
  paymentResponseHeader?: string | null;
  /** Parsed JSON request body, read for `model`. */
  requestBody?: unknown;
  /** Parsed JSON response body. */
  responseBody?: unknown;
  atUnixMs?: number;
};

type Dict = Record<string, unknown>;

function asRecord(value: unknown): Dict | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function decodeB64Json(header: string | null | undefined): Dict | null {
  if (!header) return null;
  try {
    return asRecord(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
  } catch {
    return null;
  }
}

function originOf(resource: string | undefined): string | null {
  if (!resource) return null;
  try {
    return new URL(resource).origin;
  } catch {
    return null;
  }
}

/** payTo, network and amount from a decoded v2 `accepted` requirement or a v1 EVM authorization. */
function signedTerms(payment: Dict | null): { paidTo: string | null; network: string | null; amount: string | null } {
  if (!payment) return { paidTo: null, network: null, amount: null };
  const accepted = asRecord(payment.accepted);
  if (accepted) {
    const fields = resolveRequirementFields(accepted);
    return {
      paidTo: fields.conflict ? null : str(fields.payTo),
      network: str(accepted.network),
      amount: fields.conflict ? null : str(fields.amount),
    };
  }
  const authorization = asRecord(asRecord(payment.payload)?.authorization);
  const value = authorization?.value;
  return {
    paidTo: str(authorization?.to),
    network: str(payment.network),
    amount: typeof value === "string" && /^\d+$/.test(value) ? value : null,
  };
}

function sameTx(a: string, b: string): boolean {
  // EVM hashes are hex and case-insensitive; Solana signatures are base58 and are not.
  return a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const TERMINAL_NOT_READY = new Set([
  "failed",
  "failure",
  "error",
  "errored",
  "cancelled",
  "canceled",
  "terminated",
  "refunded",
  "expired",
  "not_delivered",
  "undeliverable",
]);

/** Router profiles where the router, not the caller, picks the model. */
const ROUTER_MODEL_ALIASES = new Set(["auto", "eco", "premium", "free"]);

/** Dated or pinned snapshot of the same model: gpt-4o-2024-08-06, claude-sonnet-4-20250514, gpt-4-0613. */
const MODEL_SNAPSHOT_SUFFIX = /^-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|latest)$/;

function modelName(model: string): string {
  const lower = model.trim().toLowerCase();
  return lower.slice(lower.lastIndexOf("/") + 1);
}

/** null when the request named a router profile, so there is nothing to compare. */
export function modelMatches(requested: string, served: string): boolean | null {
  const want = modelName(requested);
  if (!want || ROUTER_MODEL_ALIASES.has(want)) return null;
  const got = modelName(served);
  if (got === want) return true;
  return got.startsWith(want) && MODEL_SNAPSHOT_SUFFIX.test(got.slice(want.length));
}

function failoverHops(body: Dict): number | null {
  const hops = body.failover_hops;
  if (typeof hops === "number" && Number.isInteger(hops) && hops >= 0) return hops;
  return Array.isArray(body.failover_from) ? body.failover_from.length : null;
}

export function buildFulfillmentRecord(input: FulfillmentInput): FulfillmentRecord {
  const terms = signedTerms(decodeB64Json(input.paymentHeader));
  const settle = decodeB64Json(input.paymentResponseHeader);
  const body = asRecord(input.responseBody) ?? {};
  const request = asRecord(input.requestBody);

  const headerTx = str(settle?.transaction);
  const bodyTx = str(asRecord(body.payment)?.transaction_hash) ?? str(body.transaction_hash);
  const settled = typeof settle?.success === "boolean" ? settle.success : null;

  const provider = str(body.provider);
  const servedModel = provider ? null : str(body.model);
  const requestedModel = str(request?.model);
  const ready = typeof body.ready === "boolean" ? body.ready : null;
  const jobStatus = str(body.status);

  const reasons: FulfillmentReason[] = [];
  if (settled === false) reasons.push("settle_failed");
  if (settled === true && (input.httpStatus < 200 || input.httpStatus > 299)) reasons.push("paid_http_error");
  if (headerTx && bodyTx && !sameTx(headerTx, bodyTx)) reasons.push("tx_disagrees");
  if (ready === false && jobStatus && TERMINAL_NOT_READY.has(jobStatus.toLowerCase())) reasons.push("not_ready");
  const modelCheck = servedModel && requestedModel ? modelMatches(requestedModel, servedModel) : null;
  if (modelCheck === false) reasons.push("model_substituted");

  const verdict: FulfillmentVerdict = reasons.length > 0
    ? "mismatch"
    : ready === false
      ? "pending"
      : ready === true || modelCheck === true
        ? "match"
        : "not_reported";

  return {
    schema: FULFILLMENT_RECORD_SCHEMA,
    at_unix_ms: input.atUnixMs ?? Date.now(),
    resource_origin: originOf(input.resource),
    http_status: input.httpStatus,
    paid_to: terms.paidTo,
    network: str(settle?.network) ?? terms.network,
    amount_atomic: terms.amount,
    tx: headerTx ?? bodyTx,
    settled,
    served_by: provider ?? servedModel,
    served_by_field: provider ? "provider" : servedModel ? "model" : null,
    requested_model: requestedModel,
    failover_hops: failoverHops(body),
    ready,
    job_status: jobStatus,
    job_id: str(body.job_id),
    verdict,
    reasons,
  };
}

function paymentHeaderOf(headers: Headers): string | null {
  return headers.get("PAYMENT-SIGNATURE") || headers.get("X-PAYMENT") || null;
}

function isJson(headers: Headers): boolean {
  return (headers.get("content-type") ?? "").toLowerCase().includes("json");
}

/** Parse a JSON body, giving up (undefined) past `maxBytes`; never throws. */
async function readJsonCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<unknown> {
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Fetch wrapper for the transport under `@x402/fetch`: on a request that carries
 * a payment header, build a fulfillment record from the response and hand it to
 * `onRecord`. The response is returned untouched and without waiting for the
 * record; a failing `onRecord` is swallowed. Event streams and non-JSON bodies
 * record header fields only.
 */
export function wrapFetchRecordFulfillment(
  inner: typeof fetch,
  onRecord: (record: FulfillmentRecord) => void,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const paymentHeader = paymentHeaderOf(headers);
    if (!paymentHeader) return inner(input, init);

    const resource = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let requestBody: Promise<unknown> = Promise.resolve(undefined);
    if (isJson(headers)) {
      if (typeof init?.body === "string") {
        const text = init.body;
        requestBody = Promise.resolve().then(() => JSON.parse(text) as unknown).catch(() => undefined);
      } else if (input instanceof Request && init?.body === undefined && !input.bodyUsed) {
        try { requestBody = readJsonCapped(input.clone().body, FULFILLMENT_MAX_BODY_BYTES); } catch { /* headers only */ }
      }
    }

    const resp = await inner(input, init);
    const responseBody = isJson(resp.headers)
      ? readJsonCapped(resp.clone().body, FULFILLMENT_MAX_BODY_BYTES)
      : Promise.resolve(undefined);
    void Promise.all([requestBody, responseBody])
      .then(([req, res]) => {
        onRecord(buildFulfillmentRecord({
          resource,
          httpStatus: resp.status,
          paymentHeader,
          paymentResponseHeader: resp.headers.get("PAYMENT-RESPONSE") || resp.headers.get("X-PAYMENT-RESPONSE"),
          requestBody: req,
          responseBody: res,
        }));
      })
      .catch(() => { /* a record must never reach the pay path */ });
    return resp;
  };
}

export type FileFulfillmentLogOptions = {
  rotateBytes?: number;
};

/**
 * Append-only JSONL file of fulfillment records. Single-process writer only.
 * `record` never blocks; `flush` waits for queued rows and fsyncs them.
 */
export function createFileFulfillmentLog(filePath: string, options: FileFulfillmentLogOptions = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const rotateBytes = options.rotateBytes ?? 64 * 1024 * 1024;
  let pending: string[] = [];
  let writer: Promise<void> = Promise.resolve();
  let scheduled = false;
  const flush = async (): Promise<void> => {
    const lines = pending;
    pending = [];
    scheduled = false;
    if (!lines.length) return writer;
    writer = writer.then(async () => {
      try { if ((await stat(filePath)).size >= rotateBytes) await rename(filePath, `${filePath}.${Date.now()}.jsonl`); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
      const handle = await open(filePath, "a");
      try { await appendFile(handle, lines.join(""), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
    });
    return writer;
  };
  process.once("beforeExit", () => { void flush(); });
  return {
    record(row: FulfillmentRecord): void {
      pending.push(JSON.stringify(row) + "\n");
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => { void flush(); });
      }
    },
    flush,
  };
}
