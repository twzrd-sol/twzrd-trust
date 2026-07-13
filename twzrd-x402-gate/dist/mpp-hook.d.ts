/**
 * TWZRD Payment Control on the Machine Payments Protocol (MPP) client path.
 *
 * Narrow scope (deliberate): Solana `charge` only. MPP's client SDK (`mppx`)
 * signs AND broadcasts the Solana transaction inside `createCredential()`, so
 * the last deterministic checkpoint before money moves is the `onChallenge`
 * callback of `Mppx.create`. The guard returned by `createTwzrdMppOnChallenge`
 * decides there:
 *
 *   - block  → the guard THROWS. `createCredential()` is never invoked; nothing
 *              is signed, nothing broadcasts. (mppx re-throws onChallenge
 *              errors after emitting `payment.failed` — returning `undefined`
 *              would proceed to pay, so refusal must be an exception.)
 *   - warn   → PROCEEDS TO PAY by default; a warn is not a refusal. Set
 *              `treatWarnAsBlock: true` to refuse on warn too.
 *   - allow  → the guard calls `helpers.createCredential()` itself and returns
 *              the credential for the exact challenge it evaluated.
 *   - other methods/intents (tempo, stripe, session) → fail-closed by default
 *              (`UNEVALUATED_METHOD`); opt out with `allowUnevaluated: true`.
 *
 * SCOPE LIMIT (honest): the guard is authoritative only when no
 * `onChallengeReceived` event handler supplies a credential. mppx resolves
 * `eventCredential ?? onChallenge(...)`, so an event handler that returns a
 * credential SHORT-CIRCUITS this callback entirely and pays ungated. Do not
 * register both on one client.
 *
 * PRICING (the load-bearing constraint): `amount` is a base-unit token
 * quantity; the policy runtime enforces ceilings in USD. Converting one to the
 * other is sound ONLY for assets pegged 1:1 to the dollar, so PaymentIntent v1
 * carries USD-pegged charges ONLY. Native SOL and unknown mints fail closed
 * (`UNPRICED_ASSET`) — there is no caller-supplied price escape hatch, because
 * a priced non-stablecoin intent would record `asset: SOL` beside `amount: <USD>`
 * and LOSE the exact token quantity actually being transferred. Binding a
 * quantity the intent does not carry is precisely the divergence this guard
 * exists to prevent. Pricing non-pegged assets needs a future intent version
 * with explicit token-amount + quote fields; until then, refuse.
 *
 * WHAT THE INTENT MUST BIND (verified against the published mppx-solana@0.2.0
 * `charge` request schema — do not infer this from docs):
 *
 *   - SPONSORED charges are refused (`SPONSORED_CHARGE`). When `sponsored` /
 *     `sponsorPath` / `feeTokenAmount` are present, mppx-solana builds a
 *     SECOND transfer — `feeTokenAmount` to the sponsor's fee payer — on top of
 *     the advertised `amount`. PaymentIntent v1 binds a single amount to a
 *     single payTo, so an approved sponsored charge would move strictly more
 *     money than the decision covered.
 *   - CLUSTER must be a known cluster name (`UNKNOWN_CLUSTER` otherwise).
 *     mppx-solana's `resolveEndpoint` ends in `return cluster`, so a
 *     seller-supplied `cluster` is used verbatim AS THE RPC ENDPOINT URL. Our
 *     classifier scores any network string containing "solana", so
 *     `solana:https://seller-rpc.example` would be scored as mainnet — reputation
 *     invented for a chain we never observed. Refuse rather than score a URL.
 *   - The DIGEST of the whole normalized challenge is bound into the intent, not
 *     just `realm:id`. Every field mppx will act on (amount, currency, decimals,
 *     recipient, cluster, memo, expiry) is covered, so any post-approval mutation
 *     changes the intent hash.
 *
 * No dependency on `mppx` — challenge types are structural, matching
 * mppx@0.8.6 `Challenge` and mppx-solana@0.2.0's `charge` request schema.
 */
import type { DecisionSigner, PaymentDecision } from "./decision-token.js";
import { type PaymentIntent } from "./intent.js";
import { type IntelligenceProvider, type Mandate, type SpendLedger, type SpendPolicy } from "./policy-runtime.js";
/** Structural mirror of mppx `Challenge` (WWW-Authenticate: Payment ...). */
export type MppChallenge = {
    id: string;
    realm: string;
    /** Payment method name (e.g. "solana", "tempo", "stripe"). */
    method: string;
    /** Intent kind (e.g. "charge", "session"). */
    intent: string;
    /** Method-specific request data. */
    request: Record<string, unknown>;
    /** ISO-8601 challenge expiry. */
    expires?: string;
    description?: string;
};
/** mppx-solana `charge` request fields the adapter consumes. */
export type MppSolanaChargeRequest = {
    /** Base-unit token amount (e.g. "50000" = 0.05 USDC at 6dp). */
    amount: string;
    /** Mint address of the payment token, or "solana:native" for SOL. */
    currency: string;
    decimals: number;
    /** Receiving wallet — the payTo. */
    recipient: string;
    cluster?: string;
    memo?: string;
    /**
     * Sponsorship fields. Their presence means a SECOND transfer that
     * PaymentIntent v1 cannot bind — the guard refuses rather than approve a
     * payment larger than the decision covers.
     */
    sponsored?: boolean;
    sponsorPath?: string;
    feeTokenAmount?: string;
    feePayer?: string;
};
/** mppx-solana's native-SOL sentinel (NATIVE_SOL_CURRENCY). */
export declare const NATIVE_SOL_CURRENCY = "solana:native";
export declare class TwzrdMppBlockError extends Error {
    readonly code: "PAYMENT_CONTROL_BLOCK" | "UNEVALUATED_METHOD" | "MALFORMED_CHALLENGE" | "UNPRICED_ASSET"
    /** Sponsored charge: a second, unbindable transfer to the sponsor. */
     | "SPONSORED_CHARGE"
    /** Cluster is not a known cluster name (i.e. it is a raw RPC endpoint). */
     | "UNKNOWN_CLUSTER";
    readonly reasonCodes?: string[];
    readonly decisionId?: string;
    constructor(code: TwzrdMppBlockError["code"], message: string, detail?: {
        reasonCodes?: string[];
        decisionId?: string;
    });
}
export type MppIntentContext = {
    /** Resource URL bound into the intent (the paid request's URL). */
    resourceUrl?: string;
    /** HTTP method of the paid request. */
    method?: string;
    /** Spend purpose (matched against mandate.purposes). */
    purpose?: string;
};
/**
 * Digest of the ENTIRE normalized challenge — every field mppx-solana will act
 * on, not just `realm:id`.
 *
 * Binding only the identifiers would let a seller (or a compromised
 * orchestration layer) keep the same challenge id while swapping `recipient`,
 * `amount`, `currency`, or `cluster` after TWZRD approved it, and the intent
 * hash would not move. The digest makes any such mutation a different intent.
 */
export declare function mppChallengeDigest(challenge: MppChallenge): string;
/**
 * Normalize an MPP Solana `charge` challenge into PaymentIntent v1.
 *
 * `intent.amount` is always a USD decimal string, because that is what the
 * policy runtime's ceilings mean. Stablecoin charges convert 1:1 from base
 * units; every other asset is refused (UNPRICED_ASSET) rather than priced.
 *
 * Only `method === "solana" && intent === "charge"` is supported. The challenge
 * id + realm are bound into `resource.operation`, so the signed decision covers
 * this exact challenge, not merely an equivalent-looking payment.
 */
export declare function mppChallengeToIntent(challenge: MppChallenge, ctx?: MppIntentContext): PaymentIntent;
export type MppOnChallengeOptions = {
    /** Ed25519 decision signer (createLocalDecisionSigner() or a remote signer). */
    signer: DecisionSigner;
    policy?: SpendPolicy;
    mandate?: Mandate;
    ledger?: SpendLedger;
    intelligence?: IntelligenceProvider;
    /** Decision token time-to-live in ms (default 120s). */
    ttlMs?: number;
    /** Clock, Unix ms. Injectable for tests. */
    now?: () => number;
    /** Spend purpose bound into the intent. */
    purpose?: string;
    /** Resource URL bound into the intent (static or derived per challenge). */
    resourceUrl?: string | ((challenge: MppChallenge) => string | undefined);
    /** HTTP method bound into the intent. */
    method?: string;
    /** Refuse on a `warn` verdict too (default false: warn proceeds to pay). */
    treatWarnAsBlock?: boolean;
    /**
     * Non-solana-charge challenges: fail-closed by default (throw
     * UNEVALUATED_METHOD before any credential exists). Set true to let mppx's
     * default flow handle them UNGATED.
     */
    allowUnevaluated?: boolean;
    /** Telemetry after each evaluation. Never throws into the payment path. */
    onDecision?: (detail: {
        challenge: MppChallenge;
        intent?: PaymentIntent;
        decision?: PaymentDecision;
        refusal?: TwzrdMppBlockError;
    }) => void;
};
/** Helpers passed by mppx to onChallenge. */
export type MppOnChallengeHelpers = {
    createCredential: (context?: unknown) => Promise<string>;
};
/**
 * TWZRD guard for `Mppx.create({ onChallenge })`.
 *
 * Authoritative at this seat (see the SCOPE LIMIT note at the top of the file:
 * an `onChallengeReceived` handler that returns a credential bypasses it).
 *
 * @example
 * ```ts
 * import { Mppx } from "mppx/client";
 * import { client as solanaClient } from "mppx-solana";
 * import { createTwzrdMppOnChallenge, createLocalDecisionSigner } from "twzrd-x402-gate";
 *
 * const mppx = Mppx.create({
 *   methods: [solanaClient({ signer: wallet })],
 *   onChallenge: createTwzrdMppOnChallenge({
 *     signer: createLocalDecisionSigner(),
 *     policy: { maxAmountUsd: "1.00" },
 *     // USDC/USDT only. SOL, sponsored charges, and custom clusters are refused.
 *   }),
 * });
 * // A blocked seller now throws BEFORE the Solana tx is signed or broadcast.
 * ```
 */
export declare function createTwzrdMppOnChallenge(options: MppOnChallengeOptions): (challenge: MppChallenge, helpers: MppOnChallengeHelpers) => Promise<string | undefined>;
//# sourceMappingURL=mpp-hook.d.ts.map