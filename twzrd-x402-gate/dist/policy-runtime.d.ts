/**
 * TWZRD Payment Control — the protocol-neutral policy runtime.
 *
 * `evaluateIntent(intent, { policy, mandate, intelligence })` combines:
 *   - LOCAL hard controls (ceilings, network/asset restrictions, allow/block
 *     lists, mandate validation, cumulative caps, recurring price checks) —
 *     deterministic, no network, keeps working through an API outage;
 *   - REMOTE intelligence (counterparty score, wash/fleet detection) via an
 *     injectable async provider;
 * and returns a signed, expiring DecisionToken bound to the intent hash.
 *
 * Deliberately NOT a policy language. Five concrete policies, evaluated in a
 * fixed order with stable reason codes.
 */
import { type DecisionSigner, type PaymentDecision } from "./decision-token.js";
import { type PaymentIntent } from "./intent.js";
export declare const POLICY_VERSION = "twzrd-pc-v1";
export type SpendPolicy = {
    /** Refuse wash-flagged counterparties (default true when intelligence runs). */
    refuseWashFlagged?: boolean;
    /** Unknown merchant: allow small spend, act above the line. */
    unknownCounterparty?: {
        allowUnderUsd: string;
        aboveAction?: "block" | "warn";
    };
    /** New counterparty: cumulative cap over a rolling window. */
    newCounterpartyCap?: {
        capUsd: string;
        windowHours: number;
    };
    /** Recurring service: block a price increase above this percentage. */
    recurringMaxPriceIncreasePct?: number;
    allowedNetworks?: string[];
    allowedAssets?: string[];
    maxAmountUsd?: string;
    blocklist?: string[];
    allowlist?: string[];
};
export type Mandate = {
    mandateId: string;
    /** Allowed spend purposes (e.g. ["software", "research_api"]). */
    purposes?: string[];
    maxPerTransactionUsd?: string;
    monthlyCeilingUsd?: string;
    /**
     * Resource binding: URL prefixes this mandate may pay for.
     * Approval for /weather cannot pay /admin/export.
     */
    resourceAllow?: string[];
    /** Explicitly forbidden payees (e.g. personal wallets). */
    payeeBlocklist?: string[];
    expiresAt?: string;
};
/** What remote intelligence contributes. All fields optional; absent = unknown. */
export type CounterpartyIntelligence = {
    known?: boolean;
    washFlagged?: boolean;
    decision?: "allow" | "warn" | "block";
    trustScore?: number;
};
export type IntelligenceProvider = (intent: PaymentIntent) => Promise<CounterpartyIntelligence> | CounterpartyIntelligence;
export type SpendLedger = {
    /** Total recorded spend (micro-USD) for a scope key within the window. */
    spentMicro(scopeKey: string, windowMs: number, now: number): bigint;
    record(scopeKey: string, amountMicro: bigint, at: number): void;
    /** First time this scope key was seen, if ever. */
    firstSeen(scopeKey: string): number | undefined;
};
export declare function createMemorySpendLedger(): SpendLedger;
export type EvaluateIntentOptions = {
    policy?: SpendPolicy;
    mandate?: Mandate;
    intelligence?: IntelligenceProvider;
    ledger?: SpendLedger;
    signer: DecisionSigner;
    /** Token time-to-live in ms (default 120s — decisions are point-in-time). */
    ttlMs?: number;
    now?: number;
    /** Record allowed spend into the ledger (default true). */
    recordSpend?: boolean;
};
/**
 * Evaluate one PaymentIntent. Never throws on a policy outcome — a block is a
 * signed block decision (auditable), not an exception. Throws only on
 * malformed input (bad amounts) or signer failure.
 */
export declare function evaluateIntent(intent: PaymentIntent, options: EvaluateIntentOptions): Promise<PaymentDecision>;
//# sourceMappingURL=policy-runtime.d.ts.map