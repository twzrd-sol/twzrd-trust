/**
 * elizaOS Provider wrapper around the dep-free trust-gate core.
 *
 * Injects the counterparty seller's TWZRD trust verdict into the agent's context
 * BEFORE it decides to pay, so the model sees "BLOCK - do not pay" for wash-flagged
 * merchants. This provider makes the agent AWARE; it does not intercept signatures.
 * Deterministic enforcement is the explicit `canSpendSafely(payTo)` call your payment
 * action makes before signing - see README.
 */
import type { Provider } from "@elizaos/core";
import { type TrustGateConfig } from "./gate.js";
/** Build a trust-gate provider with custom config (host, minScore, failOpen, timeout). */
export declare function createTrustGateProvider(config?: TrustGateConfig): Provider;
/** Default provider (hits https://intel.twzrd.xyz, decision-only gating, fail-closed). */
export declare const trustGateProvider: Provider;
