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
export declare const DELIVERY_OBSERVATION_PATH = "/v1/intel/delivery-observation";
export declare const CAPTURE_TIMEOUT_MS = 1500;
export type DeliveryCheckLevel = "example_keys" | "output_type" | "body_nonempty";
export type DeliveryObservation = {
    merchant_wallet: string;
    settlement_tx: string | null;
    http_status: number;
    schema_match: boolean;
    check_level: DeliveryCheckLevel;
    latency_ms: number | null;
    observed_at: number;
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
/** Dig extensions.bazaar.info.output out of a 402 challenge body. */
export declare function extractAdvertisedOutput(challengeBody: unknown): AdvertisedOutput;
/**
 * Verdict on the delivered body vs the merchant's own advertisement.
 * If the merchant advertises example fields it does not return, that IS a
 * delivery mismatch — the bar is the merchant's own claim, nothing invented.
 */
export declare function assessSchemaMatch(resourceBody: unknown, advertised: AdvertisedOutput): {
    schemaMatch: boolean;
    checkLevel: DeliveryCheckLevel;
};
/**
 * Best-effort settlement tx extraction from the payer's JSON output
 * (depth ≤ 2). The AgentCash CLI does not guarantee this; null is honest —
 * Phase 3 treats tx-less observations as unverifiable, not as evidence.
 */
export declare function extractSettlementTx(payerOutput: unknown, depth?: number): string | null;
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
export declare function captureDeliveryObservation(args: DeliveryCaptureArgs, cfg: ResolvedTwzrdGateConfig): Promise<DeliveryCaptureResult>;
//# sourceMappingURL=delivery-capture.d.ts.map