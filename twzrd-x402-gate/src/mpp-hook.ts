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

import { createHash } from "node:crypto";

import type { DecisionSigner, PaymentDecision } from "./decision-token.js";
import { canonicalJson, type PaymentIntent } from "./intent.js";
import {
  evaluateIntent,
  type IntelligenceProvider,
  type Mandate,
  type SpendLedger,
  type SpendPolicy,
} from "./policy-runtime.js";

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
export const NATIVE_SOL_CURRENCY = "solana:native";

/**
 * Cluster names mppx-solana maps to a real Solana RPC. Anything else is passed
 * through as a raw endpoint URL (`resolveEndpoint` ends in `return cluster`),
 * so it is not a cluster we can identify — and must never be scored.
 */
const KNOWN_CLUSTERS = new Set([
  "mainnet-beta",
  "mainnet",
  "devnet",
  "testnet",
  "localnet",
  "localhost",
]);

/**
 * Assets we can price at 1:1 USD without an oracle, with their REAL decimals.
 * A challenge that declares different decimals for these mints is lying (or
 * broken) — either way it is not evaluable, so it is refused.
 */
const USD_PEGGED_ASSETS: Record<string, number> = {
  // USDC mainnet
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
  // USDC devnet
  Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr: 6,
  // USDT mainnet
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6,
};

export class TwzrdMppBlockError extends Error {
  readonly code:
    | "PAYMENT_CONTROL_BLOCK"
    | "UNEVALUATED_METHOD"
    | "MALFORMED_CHALLENGE"
    | "UNPRICED_ASSET"
    /** Sponsored charge: a second, unbindable transfer to the sponsor. */
    | "SPONSORED_CHARGE"
    /** Cluster is not a known cluster name (i.e. it is a raw RPC endpoint). */
    | "UNKNOWN_CLUSTER";
  readonly reasonCodes?: string[];
  readonly decisionId?: string;

  constructor(
    code: TwzrdMppBlockError["code"],
    message: string,
    detail?: { reasonCodes?: string[]; decisionId?: string },
  ) {
    super(message);
    this.name = "TwzrdMppBlockError";
    this.code = code;
    this.reasonCodes = detail?.reasonCodes;
    this.decisionId = detail?.decisionId;
  }
}

/**
 * Base units -> whole-token decimal string. Rejects anything it cannot scale
 * exactly (non-integer amount, non-integer/negative decimals) rather than
 * returning the raw string, which the runtime would misread as a USD figure.
 */
function baseUnitsToDecimal(units: string, decimals: number): string {
  const t = String(units).trim();
  if (!/^\d+$/.test(t)) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      `[twzrd] MPP charge amount is not a base-unit integer: ${JSON.stringify(units)}`,
    );
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      `[twzrd] MPP charge has unusable decimals: ${JSON.stringify(decimals)}`,
    );
  }
  if (decimals === 0) return t;
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(t);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
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
export function mppChallengeDigest(challenge: MppChallenge): string {
  const req = (challenge.request ?? {}) as Record<string, unknown>;
  const normalized = {
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
    expires: challenge.expires ?? null,
    // Every request field, not a curated subset: an unknown field that mppx
    // acts on must still change the digest.
    request: Object.fromEntries(
      Object.keys(req)
        .sort()
        .map((k) => [k, req[k] ?? null]),
    ),
  };
  return createHash("sha256").update(canonicalJson(normalized), "utf8").digest("hex");
}

/** Structural deep-freeze so telemetry cannot mutate the challenge mid-flight. */
function frozenClone<T>(value: T): T {
  return Object.freeze(
    JSON.parse(JSON.stringify(value), (_k, v) =>
      v && typeof v === "object" ? Object.freeze(v) : v,
    ),
  ) as T;
}

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
export function mppChallengeToIntent(
  challenge: MppChallenge,
  ctx?: MppIntentContext,
): PaymentIntent {
  if (challenge.method !== "solana" || challenge.intent !== "charge") {
    throw new TwzrdMppBlockError(
      "UNEVALUATED_METHOD",
      `[twzrd] MPP guard evaluates solana/charge only; got ${challenge.method}/${challenge.intent}`,
    );
  }
  const req = challenge.request as Partial<MppSolanaChargeRequest>;
  if (
    typeof req.recipient !== "string" ||
    !req.recipient ||
    typeof req.currency !== "string" ||
    !req.currency ||
    (typeof req.amount !== "string" && typeof req.amount !== "number") ||
    typeof req.decimals !== "number"
  ) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP solana charge challenge missing/mistyped recipient, amount, currency, or decimals",
    );
  }

  // SPONSORSHIP: mppx-solana adds a SECOND transfer of `feeTokenAmount` to the
  // sponsor's fee payer, on top of `amount` to `recipient`. PaymentIntent v1
  // binds one amount to one payTo, so approving this would authorize strictly
  // more money than the decision covers — the exact approve/execute divergence
  // the intent hash exists to prevent. Refuse until an intent version can carry
  // multiple legs.
  if (
    req.sponsored === true ||
    typeof req.sponsorPath === "string" ||
    typeof req.feeTokenAmount === "string"
  ) {
    throw new TwzrdMppBlockError(
      "SPONSORED_CHARGE",
      "[twzrd] MPP sponsored charge refused: it transfers feeTokenAmount" +
        `${req.feeTokenAmount ? ` (${req.feeTokenAmount})` : ""} to a sponsor in addition to` +
        " the advertised amount, and PaymentIntent v1 binds only a single transfer." +
        " Approving it would authorize more value than the signed decision covers.",
    );
  }

  // CLUSTER: mppx-solana's resolveEndpoint returns an unrecognized cluster
  // verbatim as the RPC endpoint URL. A seller-supplied endpoint is not a
  // cluster we can identify, and our classifier scores anything containing
  // "solana" — so `solana:https://seller-rpc.example` would be scored as
  // mainnet. Never score a URL; refuse it.
  const cluster = req.cluster ?? "mainnet-beta";
  if (!KNOWN_CLUSTERS.has(cluster)) {
    throw new TwzrdMppBlockError(
      "UNKNOWN_CLUSTER",
      `[twzrd] MPP charge names an unknown cluster ${JSON.stringify(cluster)}.` +
        " mppx-solana uses this verbatim as the RPC endpoint, so it identifies no known" +
        " chain and must not inherit mainnet reputation. Known clusters: " +
        [...KNOWN_CLUSTERS].join(", "),
    );
  }

  const pegDecimals = USD_PEGGED_ASSETS[req.currency];

  // ASSET: PaymentIntent v1 carries USD-pegged assets ONLY. A priced SOL charge
  // would store `asset: solana:native` beside `amount: <USD>` and lose the token
  // quantity actually transferred — binding a number that is not the number the
  // wallet signs. Refuse; a future intent version needs tokenAmount + quote.
  if (pegDecimals === undefined) {
    const raw = String(req.amount);
    throw new TwzrdMppBlockError(
      "UNPRICED_ASSET",
      `[twzrd] MPP charge in non-USD-pegged asset ${req.currency} (${raw} base units).` +
        " PaymentIntent v1 expresses amounts in USD, so pricing this would record a dollar" +
        " figure while losing the exact token quantity being transferred. Refused by design.",
    );
  }

  // A stablecoin challenge that misdeclares decimals is not evaluable: the
  // declared value scales the amount, so trusting it would let a seller pass
  // 1e9 USDC base units off as "$1" (mppx-solana's transfer_checked would also
  // reject the mismatch on-chain — refuse before signing, not after).
  if (req.decimals !== pegDecimals) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      `[twzrd] MPP charge declares decimals=${req.decimals} for a mint with ${pegDecimals} decimals`,
    );
  }

  const amountUsd = baseUnitsToDecimal(String(req.amount), req.decimals); // 1 token == 1 USD

  return {
    protocol: "mpp",
    network: `solana:${cluster}`,
    asset: req.currency,
    amount: amountUsd,
    payTo: req.recipient,
    resource: {
      url: ctx?.resourceUrl,
      method: ctx?.method,
      // Bind the WHOLE challenge, not just its identifiers: swapping recipient
      // or amount under the same id changes this digest, hence the intent hash.
      operation: `mpp-charge:${challenge.realm}:${challenge.id}:${mppChallengeDigest(challenge)}`,
    },
    context: {
      purpose: ctx?.purpose,
      expiresAt: challenge.expires,
    },
  };
}

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
export function createTwzrdMppOnChallenge(
  options: MppOnChallengeOptions,
): (challenge: MppChallenge, helpers: MppOnChallengeHelpers) => Promise<string | undefined> {
  return async (challenge, helpers) => {
    let intent: PaymentIntent;
    try {
      intent = mppChallengeToIntent(challenge, {
        resourceUrl:
          typeof options.resourceUrl === "function"
            ? options.resourceUrl(challenge)
            : options.resourceUrl,
        method: options.method,
        purpose: options.purpose,
      });
    } catch (error) {
      const refusal = asBlockError(error, "MALFORMED_CHALLENGE");
      if (refusal.code === "UNEVALUATED_METHOD" && options.allowUnevaluated) {
        emitDecision(options, { challenge });
        return undefined; // explicit opt-out: mppx default flow, ungated
      }
      emitDecision(options, { challenge, refusal });
      throw refusal;
    }

    let decision: PaymentDecision;
    try {
      decision = await evaluateIntent(intent, {
        signer: options.signer,
        policy: options.policy,
        mandate: options.mandate,
        ledger: options.ledger,
        intelligence: options.intelligence,
        ttlMs: options.ttlMs,
        now: options.now?.(),
      });
    } catch (error) {
      // A runtime failure (bad amount, signer error) must never fall through to
      // payment: refuse, exactly as a block would.
      const refusal = asBlockError(error, "MALFORMED_CHALLENGE");
      emitDecision(options, { challenge, intent, refusal });
      throw refusal;
    }
    emitDecision(options, { challenge, intent, decision });

    const refuse =
      decision.decision === "block" ||
      (decision.decision === "warn" && options.treatWarnAsBlock === true);
    if (refuse) {
      throw new TwzrdMppBlockError(
        "PAYMENT_CONTROL_BLOCK",
        `[twzrd] mpp_payment_control_${decision.decision}:${decision.reasonCodes.join(",")} payTo=${intent.payTo}`,
        { reasonCodes: decision.reasonCodes, decisionId: decision.decisionId },
      );
    }
    // allow (or warn, when not treated as block): create the credential for the
    // EXACT challenge evaluated.
    return helpers.createCredential();
  };
}

/** Normalize any thrown value into a TwzrdMppBlockError so callers can branch on .code. */
function asBlockError(
  error: unknown,
  fallback: TwzrdMppBlockError["code"],
): TwzrdMppBlockError {
  if (error instanceof TwzrdMppBlockError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new TwzrdMppBlockError(fallback, `[twzrd] MPP evaluation failed: ${message}`);
}

function emitDecision(
  options: MppOnChallengeOptions,
  detail: {
    challenge: MppChallenge;
    intent?: PaymentIntent;
    decision?: PaymentDecision;
    refusal?: TwzrdMppBlockError;
  },
): void {
  if (!options.onDecision) return;
  try {
    // Telemetry runs BEFORE createCredential(). Handing it the live challenge
    // object would let an observer mutate the very fields the decision was
    // signed over, between evaluation and signing. Emit a frozen copy.
    options.onDecision({ ...detail, challenge: frozenClone(detail.challenge) });
  } catch {
    // never break the payment path on telemetry
  }
}
