/**
 * Delivery observation capture — Phase 2 of the delivery-proof plan.
 *
 * Phase 1 (twzrd-agent-intel delivery_signal.py) opened a fail-open scoring
 * seam that consumes {merchant_wallet, settlement_tx, http_status,
 * schema_match, latency_ms, observed_at} observations. This module produces
 * them PASSIVELY: evidence is derived from a paid safe-fetch that already
 * happened — no extra requests, no probe spend, no response bodies shipped.
 *
 * The schema verdict is computed client-side against what the merchant itself
 * advertised in its 402 challenge (extensions.bazaar.info.output). The bazaar
 * advertisement is {type, example}, not a strict JSON Schema, so the verdict
 * carries an explicit check_level — the server weighs evidence accordingly
 * and never has to guess how deep the check went:
 *
 *   example_keys   every top-level key of the advertised example is present
 *   output_type    advertised type=json and the response parsed as JSON
 *   body_nonempty  nothing advertised; the response was non-empty
 *
 * Fire-and-forget: capture must NEVER throw into the pay path and never
 * delay it beyond CAPTURE_TIMEOUT_MS. A missing/erroring collector endpoint
 * (Phase 3 ships it) degrades to posted:false silently.
 *
 * Kill switches: TWZRD_DELIVERY_CAPTURE=0|false, or deliveryCapture:false in
 * SafeFetchOptions. Server-side settlement verification, internal-wallet
 * scrub, and per-tx dedupe are Phase 3 concerns — a client-side bool is
 * never trusted alone.
 */

import type { ResolvedTwzrdGateConfig } from "./config.js";
import { CLIENT_VERSION } from "./version.js";

export const DELIVERY_OBSERVATION_PATH = "/v1/intel/delivery-observation";
export const CAPTURE_TIMEOUT_MS = 1500;

export type DeliveryCheckLevel = "example_keys" | "output_type" | "body_nonempty";

export type DeliveryObservation = {
  merchant_wallet: string;
  settlement_tx: string | null;
  http_status: number;
  schema_match: boolean;
  check_level: DeliveryCheckLevel;
  latency_ms: number | null;
  observed_at: number; // unix seconds
  resource?: string;
  network?: string;
  source: "gate_post_settle";
};

export type DeliveryCaptureResult = {
  posted: boolean;
  observation: DeliveryObservation;
};

/** What the merchant's own 402 challenge advertised about its paid output. */
export type AdvertisedOutput = {
  jsonExpected: boolean;
  exampleKeys: string[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Dig extensions.bazaar.info.output out of a 402 challenge body. */
export function extractAdvertisedOutput(challengeBody: unknown): AdvertisedOutput {
  const none: AdvertisedOutput = { jsonExpected: false, exampleKeys: [] };
  const ext = asRecord(asRecord(challengeBody)?.extensions);
  const bazaar = asRecord(ext?.bazaar);
  const info = asRecord(bazaar?.info);
  const output = asRecord(info?.output);
  if (!output) return none;
  const jsonExpected =
    typeof output.type === "string" && output.type.toLowerCase() === "json";
  const example = asRecord(output.example);
  return { jsonExpected, exampleKeys: example ? Object.keys(example) : [] };
}

/**
 * Verdict on the delivered body vs the merchant's own advertisement.
 * If the merchant advertises example fields it does not return, that IS a
 * delivery mismatch — the bar is the merchant's own claim, nothing invented.
 */
export function assessSchemaMatch(
  resourceBody: unknown,
  advertised: AdvertisedOutput,
): { schemaMatch: boolean; checkLevel: DeliveryCheckLevel } {
  const bodyObj = asRecord(resourceBody);
  if (advertised.exampleKeys.length > 0) {
    const schemaMatch =
      bodyObj != null && advertised.exampleKeys.every((k) => k in bodyObj);
    return { schemaMatch, checkLevel: "example_keys" };
  }
  if (advertised.jsonExpected) {
    const isJson = bodyObj != null || Array.isArray(resourceBody);
    return { schemaMatch: isJson, checkLevel: "output_type" };
  }
  const nonEmpty =
    resourceBody != null &&
    !(typeof resourceBody === "string" && resourceBody.trim() === "");
  return { schemaMatch: nonEmpty, checkLevel: "body_nonempty" };
}

const B58_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{43,88}$/;
const TX_KEYS = new Set([
  "settlement_tx",
  "settlementtx",
  "tx",
  "txhash",
  "tx_hash",
  "signature",
  "transactionsignature",
  "settlement_anchor_tx",
]);

/**
 * Best-effort settlement tx extraction from the payer's JSON output
 * (depth ≤ 2). The AgentCash CLI does not guarantee this; null is honest —
 * Phase 3 treats tx-less observations as unverifiable, not as evidence.
 */
export function extractSettlementTx(payerOutput: unknown, depth = 0): string | null {
  const rec = asRecord(payerOutput);
  if (!rec || depth > 2) return null;
  for (const [key, value] of Object.entries(rec)) {
    if (
      TX_KEYS.has(key.toLowerCase()) &&
      typeof value === "string" &&
      B58_SIG_RE.test(value)
    ) {
      return value;
    }
  }
  for (const value of Object.values(rec)) {
    const nested = extractSettlementTx(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function captureDisabledByEnv(): boolean {
  const v = process.env.TWZRD_DELIVERY_CAPTURE;
  return v === "0" || v === "false";
}

export type DeliveryCaptureArgs = {
  merchantWallet: string;
  httpStatus: number;
  resourceBody: unknown;
  /** The 402 challenge body the merchant advertised its output in. */
  challengeBody: unknown;
  /** Payer output to mine for the settlement tx (may equal resourceBody). */
  payerOutput?: unknown;
  latencyMs?: number | null;
  resource?: string;
  network?: string;
  /** SafeFetchOptions.deliveryCapture; default true. */
  enabled?: boolean;
};

/**
 * Build the observation and fire-and-forget POST it to the intel collector.
 * Resolves {posted:false} on disable, timeout, network error, or non-2xx —
 * never throws, never blocks the pay path beyond CAPTURE_TIMEOUT_MS.
 */
export async function captureDeliveryObservation(
  args: DeliveryCaptureArgs,
  cfg: ResolvedTwzrdGateConfig,
): Promise<DeliveryCaptureResult> {
  const advertised = extractAdvertisedOutput(args.challengeBody);
  const { schemaMatch, checkLevel } = assessSchemaMatch(args.resourceBody, advertised);
  const observation: DeliveryObservation = {
    merchant_wallet: args.merchantWallet,
    settlement_tx: extractSettlementTx(args.payerOutput ?? args.resourceBody),
    http_status: args.httpStatus,
    schema_match: schemaMatch,
    check_level: checkLevel,
    latency_ms: args.latencyMs ?? null,
    observed_at: Math.floor(Date.now() / 1000),
    resource: args.resource,
    network: args.network,
    source: "gate_post_settle",
  };

  if (args.enabled === false || captureDisabledByEnv()) {
    return { posted: false, observation };
  }

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "X-Twzrd-Caller": cfg.attribution
        ? `${cfg.attribution.integration}@${CLIENT_VERSION}`
        : `twzrd-x402-gate/${CLIENT_VERSION}`,
    };
    if (cfg.attribution) {
      headers["X-Twzrd-Integration"] = cfg.attribution.integration;
      headers["X-Twzrd-Run-Id"] = cfg.attribution.runId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
    try {
      const resp = await cfg.fetch(`${cfg.intelBase}${DELIVERY_OBSERVATION_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(observation),
        signal: controller.signal,
      });
      return { posted: resp.ok, observation };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { posted: false, observation };
  }
}
