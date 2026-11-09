import { isTrueFlag } from "./config.js";
/**
 * TWZRD Payment Control on the Machine Payments Protocol (MPP) client path.
 *
 * Narrow scope (deliberate): Solana `charge` and Tempo `charge` only. MPP's client SDK (`mppx`)
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
 *   - other methods/intents (stripe, session) → fail-closed by default
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
 *   - SPLITS are refused (`MALFORMED_CHALLENGE`). `@solana/mpp` 0.7.0
 *     `buildChargeTransaction` subtracts `methodDetails.splits` from the
 *     primary amount and adds a transfer to each split recipient. A non-empty
 *     `splits` array on the request or under `methodDetails` is more than one
 *     leg. `methodDetails.feePayer: true` is not that.
 *   - A field named at the top level and under `methodDetails` with two
 *     different values is refused (`MALFORMED_CHALLENGE`). That client pays
 *     `methodDetails.network` and `methodDetails.decimals`, and the top-level
 *     `amount`, `currency`, and `recipient`. Silent preference for one side
 *     would approve a different payment than the wallet signs.
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
import { join, resolve } from "node:path";

import {
  DEFAULT_CAP_PAUSE_WINDOW_MS,
  isFatalGateRefusal,
  readSentinelState,
  writePauseSentinel,
} from "./binding-plane.js";
import type { DecisionSigner, PaymentDecision } from "./decision-token.js";
import { canonicalJson, toMicroUsd, type PaymentIntent } from "./intent.js";
import {
  createDefaultMppFulfillmentLedgerSink,
  sharedFileDecisionLedger,
} from "./decision-ledger-file.js";
import {
  createTwzrdIntelligenceProvider,
  type TwzrdIntelligenceOptions,
} from "./intelligence.js";
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

/** Structural mirror of the normalized mppx Tempo `charge` request. */
export type MppTempoChargeRequest = {
  /** TIP-20 base units, serialized as a decimal integer string. */
  amount: string;
  currency: string;
  recipient: string;
  methodDetails?: Record<string, unknown>;
  description?: string;
  externalId?: string;
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
  // USDC devnet (Circle; the @x402/svm default)
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": 6,
  // USDC devnet (spl-token-faucet)
  Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr: 6,
  // USDT mainnet
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6,
};

/** Mints that exist on Solana mainnet. `mainnet` and `mainnet-beta` are one cluster. */
const MAINNET_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

/** Mints that exist on Solana devnet. A mainnet mint here is a different asset. */
const DEVNET_MINTS = new Set([
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr",
]);

/** Tempo chain ids accepted by the client and the gate's known USD TIP-20 list. */
const TEMPO_USD_ASSETS: Readonly<Record<number, ReadonlySet<string>>> = {
  // mppx 0.17's default Tempo charge offers (OUSD, USDC.e) on mainnet and
  // (OUSD, pathUSD) on Moderato. pathUSD is also deployed on mainnet.
  4217: new Set([
    "0x20c0000000000000000000006a37da5c996874be", // OUSD
    "0x20c000000000000000000000b9537d11c60e8b50", // USDC.e
    "0x20c0000000000000000000000000000000000000", // pathUSD
  ]),
  42431: new Set([
    "0x20c0000000000000000000006a37da5c996874be", // OUSD
    "0x20c0000000000000000000000000000000000000", // pathUSD
  ]),
};

const TEMPO_REQUEST_FIELDS = new Set([
  "amount",
  "currency",
  "recipient",
  "description",
  "externalId",
  "methodDetails",
  "network",
  "chainId",
]);
const TEMPO_METHOD_DETAIL_FIELDS = new Set([
  "chainId",
  "feePayer",
  "machineTokenEnabled",
  "memo",
  "splits",
  "supportedModes",
  "network",
]);

/**
 * `@solana/mpp` 0.7.0 `normalizeNetwork` maps both spellings to `mainnet`.
 * They share one RPC and one mint table.
 */
function canonicalCluster(cluster: string): string {
  const lower = cluster.toLowerCase();
  if (lower === "mainnet" || lower === "mainnet-beta") return "mainnet";
  return lower;
}

export class TwzrdMppBlockError extends Error {
  readonly code:
    | "PAYMENT_CONTROL_BLOCK"
    | "UNEVALUATED_METHOD"
    | "MALFORMED_CHALLENGE"
    | "UNPRICED_ASSET"
    /** Sponsored charge: a second, unbindable transfer to the sponsor. */
    | "SPONSORED_CHARGE"
    /** Cluster is not a known cluster name (i.e. it is a raw RPC endpoint). */
    | "UNKNOWN_CLUSTER"
    | "UNKNOWN_CHAIN"
    | "DECISION_LOG_UNAVAILABLE";
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
  const frac = (value % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export type MppIntentContext = {
  /** Resource URL bound into the intent (the paid request's URL). */
  resourceUrl?: string;
  /** HTTP method of the paid request. */
  method?: string;
  /** Spend purpose (matched against mandate.purposes). */
  purpose?: string;
  /** Clock used to reject an expired challenge (Unix ms). */
  now?: number;
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
  return createHash("sha256")
    .update(canonicalJson(normalized), "utf8")
    .digest("hex");
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
  if (challenge.method === "tempo") {
    return mppTempoChargeToIntent(challenge, ctx);
  }
  if (challenge.method !== "solana" || challenge.intent !== "charge") {
    throw new TwzrdMppBlockError(
      "UNEVALUATED_METHOD",
      `[twzrd] MPP guard evaluates solana/charge only; got ${challenge.method}/${challenge.intent}`,
    );
  }
  const raw = (challenge.request ?? {}) as Record<string, unknown>;
  const details =
    raw.methodDetails &&
    typeof raw.methodDetails === "object" &&
    !Array.isArray(raw.methodDetails)
      ? (raw.methodDetails as Record<string, unknown>)
      : {};
  // Community mppx-solana puts decimals/cluster on the request. The Solana
  // Foundation @solana/mpp charge, which intel.twzrd.xyz sends, nests them in
  // methodDetails. When only one side names a field, that side is used. When
  // both name it and the values differ, refuse: @solana/mpp 0.7.0
  // buildChargeTransaction pays methodDetails.network and methodDetails.decimals,
  // and the top-level amount, currency, and recipient.
  const stringField = (value: unknown): string | undefined =>
    typeof value === "string" && value ? value : undefined;
  const isSet = (value: unknown): boolean =>
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value));
  const sameScalar = (top: unknown, nested: unknown): boolean => {
    if (typeof top === "number" && typeof nested === "number")
      return top === nested;
    if (
      (typeof top === "string" || typeof top === "number") &&
      (typeof nested === "string" || typeof nested === "number")
    ) {
      return String(top) === String(nested);
    }
    return false;
  };
  const refuseIfBothDiffer = (
    label: string,
    top: unknown,
    nested: unknown,
  ): void => {
    if (!isSet(top) || !isSet(nested) || sameScalar(top, nested)) return;
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      `[twzrd] MPP charge ${label} is named twice and the values differ.` +
        " @solana/mpp pays methodDetails.network and methodDetails.decimals," +
        " and the top-level amount, currency, and recipient." +
        " PaymentIntent v1 cannot bind both.",
    );
  };
  const hasSplits = (value: unknown): boolean => {
    if (value == null) return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  };
  if (hasSplits(raw.splits) || hasSplits(details.splits)) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP charge splits are refused: @solana/mpp pays each split" +
        " recipient in addition to the primary, and PaymentIntent v1 binds one" +
        " amount to one payTo.",
    );
  }
  refuseIfBothDiffer("recipient", raw.recipient, details.recipient);
  refuseIfBothDiffer("currency", raw.currency, details.currency);
  refuseIfBothDiffer("amount", raw.amount, details.amount);
  refuseIfBothDiffer("decimals", raw.decimals, details.decimals);
  const topCluster = stringField(raw.cluster) ?? stringField(raw.network);
  const nestedCluster =
    stringField(details.cluster) ?? stringField(details.network);
  if (
    topCluster &&
    nestedCluster &&
    canonicalCluster(topCluster) !== canonicalCluster(nestedCluster)
  ) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP charge cluster is named twice and the values differ." +
        " @solana/mpp treats mainnet and mainnet-beta as one cluster." +
        " Any other pair is two chains, and PaymentIntent v1 cannot bind both.",
    );
  }
  const req = {
    ...(raw as Partial<MppSolanaChargeRequest>),
    recipient: stringField(raw.recipient) ?? stringField(details.recipient),
    currency: stringField(raw.currency) ?? stringField(details.currency),
    amount:
      typeof raw.amount === "string" || typeof raw.amount === "number"
        ? raw.amount
        : typeof details.amount === "string" ||
            typeof details.amount === "number"
          ? details.amount
          : undefined,
    decimals:
      typeof raw.decimals === "number"
        ? raw.decimals
        : typeof details.decimals === "number"
          ? details.decimals
          : undefined,
    // Foundation uses methodDetails.network. Community uses cluster, sometimes network.
    cluster:
      stringField(raw.cluster) ??
      stringField(raw.network) ??
      stringField(details.cluster) ??
      stringField(details.network),
  };
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

  // methodDetails.feePayer === true is the Foundation SOL fee-payer flag, not
  // this second token leg. Do not fold it into `sponsored`.
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

  // MINT VERSUS CLUSTER: @solana/mpp 0.7.0 resolveStablecoinMint returns a raw
  // mint unchanged, and buildChargeTransaction will sign a seller-supplied
  // blockhash without fetching one from the named network. A devnet label plus
  // the mainnet USDC mint is therefore a mainnet transfer scored as devnet.
  const canonical = canonicalCluster(cluster);
  const mintsForCluster =
    canonical === "mainnet"
      ? MAINNET_MINTS
      : canonical === "devnet"
        ? DEVNET_MINTS
        : null;
  if (USD_PEGGED_ASSETS[req.currency] !== undefined) {
    if (mintsForCluster === null || !mintsForCluster.has(req.currency)) {
      throw new TwzrdMppBlockError(
        "MALFORMED_CHALLENGE",
        `[twzrd] MPP charge mint ${req.currency} is not a USD-pegged mint on ${cluster}.` +
          " mainnet and mainnet-beta accept mainnet mints only. devnet accepts devnet" +
          " mints only. testnet, localnet, and localhost are not scored.",
      );
    }
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

/**
 * Normalize a Tempo `charge` challenge into PaymentIntent v1.
 *
 * Only the USD TIP-20 currencies used by mppx's Tempo charge defaults are
 * priced, with the protocol's fixed six decimals. Split payments and the
 * optional machine-token swap route are refused because they can execute
 * additional transfers or consume a different input amount than this single
 * payment intent covers. Chain ID must be explicit: the client can otherwise
 * choose its configured wallet chain, which is not bound by the challenge.
 */
export function mppTempoChargeToIntent(
  challenge: MppChallenge,
  ctx?: MppIntentContext,
): PaymentIntent {
  if (challenge.method !== "tempo" || challenge.intent !== "charge") {
    throw new TwzrdMppBlockError(
      "UNEVALUATED_METHOD",
      `[twzrd] MPP guard evaluates tempo/charge only; got ${challenge.method}/${challenge.intent}`,
    );
  }

  if (
    typeof challenge.id !== "string" ||
    !challenge.id ||
    typeof challenge.realm !== "string" ||
    !challenge.realm
  ) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo charge requires non-empty challenge id and realm",
    );
  }

  const raw = challenge.request;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo charge request must be an object",
    );
  }
  for (const key of Object.keys(raw)) {
    if (!TEMPO_REQUEST_FIELDS.has(key)) {
      throw new TwzrdMppBlockError(
        "MALFORMED_CHALLENGE",
        `[twzrd] MPP Tempo charge has unsupported request field ${JSON.stringify(key)}`,
      );
    }
  }

  const detailsValue = raw.methodDetails;
  if (
    detailsValue !== undefined &&
    (!detailsValue ||
      typeof detailsValue !== "object" ||
      Array.isArray(detailsValue))
  ) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo methodDetails must be an object",
    );
  }
  const details = (detailsValue ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(details)) {
    if (!TEMPO_METHOD_DETAIL_FIELDS.has(key)) {
      throw new TwzrdMppBlockError(
        "MALFORMED_CHALLENGE",
        `[twzrd] MPP Tempo charge has unsupported methodDetails field ${JSON.stringify(key)}`,
      );
    }
  }

  if (
    typeof raw.amount !== "string" ||
    typeof raw.currency !== "string" ||
    typeof raw.recipient !== "string"
  ) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo charge requires string amount, currency, and recipient",
    );
  }
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(raw.currency) ||
    !/^0x[0-9a-fA-F]{40}$/.test(raw.recipient)
  ) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo charge currency and recipient must be 20-byte EVM addresses",
    );
  }

  const networkValues = [raw.network, details.network].filter(
    (v) => v !== undefined,
  );
  if (
    networkValues.some((v) => typeof v !== "string" || !/^eip155:\d+$/.test(v))
  ) {
    throw new TwzrdMppBlockError(
      "UNKNOWN_CHAIN",
      "[twzrd] MPP Tempo charge network must be a known eip155 CAIP-2 identifier",
    );
  }
  const networkChainIds = networkValues.map((v) =>
    Number(String(v).slice("eip155:".length)),
  );
  const chainIdValues = [raw.chainId, details.chainId].filter(
    (v) => v !== undefined,
  );
  if (
    chainIdValues.some(
      (v) => typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0,
    )
  ) {
    throw new TwzrdMppBlockError(
      "UNKNOWN_CHAIN",
      "[twzrd] MPP Tempo charge chainId must be a positive safe integer",
    );
  }
  const ids = [...(chainIdValues as number[]), ...networkChainIds];
  if (ids.length === 0 || ids.some((id) => id !== ids[0])) {
    throw new TwzrdMppBlockError(
      "UNKNOWN_CHAIN",
      "[twzrd] MPP Tempo charge requires one explicit, non-conflicting chain ID / CAIP-2 network",
    );
  }
  const chainId = ids[0];
  const network = `eip155:${chainId}`;
  const assets = TEMPO_USD_ASSETS[chainId];
  if (!assets) {
    throw new TwzrdMppBlockError(
      "UNKNOWN_CHAIN",
      `[twzrd] MPP Tempo charge chain ${chainId} is not in the supported Tempo network set`,
    );
  }

  const currency = raw.currency.toLowerCase();
  if (!assets.has(currency)) {
    throw new TwzrdMppBlockError(
      "UNPRICED_ASSET",
      `[twzrd] MPP Tempo charge currency ${raw.currency} is not a supported USD TIP-20 on ${network}`,
    );
  }

  const amountBaseUnits = raw.amount;
  const amountInteger = /^[0-9]+$/.test(amountBaseUnits)
    ? BigInt(amountBaseUnits)
    : 0n;
  if (amountInteger <= 0n || amountInteger > (1n << 256n) - 1n) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo charge amount must be a positive base-10 integer",
    );
  }

  if (Object.hasOwn(details, "splits")) {
    const splits = details.splits;
    if (!Array.isArray(splits)) {
      throw new TwzrdMppBlockError(
        "MALFORMED_CHALLENGE",
        "[twzrd] MPP Tempo splits must be an array",
      );
    }
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo charge splits are refused: PaymentIntent v1 binds one recipient and amount",
    );
  }
  if (
    details.machineTokenEnabled !== undefined &&
    typeof details.machineTokenEnabled !== "boolean"
  ) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo machineTokenEnabled must be boolean",
    );
  }
  if (details.machineTokenEnabled === true) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo machine-token route is refused because it may consume a different input amount",
    );
  }
  if (
    details.feePayer !== undefined &&
    typeof details.feePayer !== "boolean" &&
    (!details.feePayer ||
      typeof details.feePayer !== "object" ||
      Array.isArray(details.feePayer))
  ) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo feePayer must be boolean or an object",
    );
  }
  if (
    details.memo !== undefined &&
    (typeof details.memo !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(details.memo))
  ) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo memo must be a bytes32 hex value",
    );
  }
  if (
    details.supportedModes !== undefined &&
    (!Array.isArray(details.supportedModes) ||
      details.supportedModes.length === 0 ||
      details.supportedModes.some((mode) => mode !== "pull" && mode !== "push"))
  ) {
    throw new TwzrdMppBlockError(
      "MALFORMED_CHALLENGE",
      "[twzrd] MPP Tempo supportedModes must contain pull and/or push",
    );
  }

  if (challenge.expires !== undefined) {
    const expiryMs = Date.parse(challenge.expires);
    const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(challenge.expires);
    if (
      !hasTimezone ||
      !Number.isFinite(expiryMs) ||
      expiryMs <= (ctx?.now ?? Date.now())
    ) {
      throw new TwzrdMppBlockError(
        "MALFORMED_CHALLENGE",
        "[twzrd] MPP Tempo charge expiry is malformed or already elapsed",
      );
    }
  }

  const amountUsd = baseUnitsToDecimal(amountBaseUnits, 6);
  return {
    protocol: "mpp",
    network,
    asset: currency,
    amount: amountUsd,
    payTo: raw.recipient.toLowerCase(),
    resource: {
      url: ctx?.resourceUrl,
      method: ctx?.method,
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
  /** Local append-only decision ledger. Defaults to .twzrd/decisions.jsonl. */
  decisionFile?: string;
  /** Spend purpose bound into the intent. */
  purpose?: string;
  /** Resource URL bound into the intent (static or derived per challenge). */
  resourceUrl?: string | ((challenge: MppChallenge) => string | undefined);
  /** HTTP method bound into the intent. */
  method?: string;
  /** Refuse on a `warn` verdict too (default false: warn proceeds to pay). */
  treatWarnAsBlock?: boolean;
  /**
   * Unevaluated methods/intents: fail-closed by default (throw
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
  /** Optional Track 5 binding-plane sentinel directory. */
  stateDir?: string;
  /** Explicit `.kill` sentinel path override. */
  killFilePath?: string;
  /** Explicit `.pause` sentinel path override. */
  pauseFilePath?: string;
  /** Optional TTL (ms) to write `<stateDir>/.pause` when a payment is blocked. */
  tripPauseOnBlockMs?: number;
};

/** Helpers passed by mppx to onChallenge. */
export type MppOnChallengeHelpers = {
  createCredential: (context?: unknown) => Promise<string>;
};

export type MppChargeEvaluation = {
  /** Exact normalized challenge that was evaluated. */
  intent: PaymentIntent;
  /** Signed policy result and its reason codes. */
  decision: PaymentDecision;
  /** Final action after `treatWarnAsBlock` is applied. */
  disposition: "allow" | "warn" | "block";
};

export type TwzrdMppIntegrationChallenge = {
  id: string;
  realm?: string;
  method: string;
  intent: string;
  request: Record<string, unknown>;
  expires?: string;
  description?: string;
};

export type TwzrdMppIntegrationOptions = Omit<
  MppOnChallengeOptions,
  "allowUnevaluated"
> & {
  intelligenceOptions?: TwzrdIntelligenceOptions;
  /** Explicit opt-in to unscored networks; requires policy.maxAmountUsd. */
  allowUnscoredNetwork?: boolean;
};

/**
 * One-file MPP integration for client rails: decisions are durably recorded
 * before the callback returns to the signer, and projected fulfillment events
 * append to the same local ledger. No network reporting is enabled here.
 */
export function createTwzrdMppIntegration(
  options: TwzrdMppIntegrationOptions,
) {
  const decisionFile = resolve(
    options.decisionFile ?? ".twzrd/decisions.jsonl",
  );
  const ledger = sharedFileDecisionLedger(decisionFile, {
    flushBeforeExit: true,
  });
  if (options.allowUnscoredNetwork && options.policy?.maxAmountUsd === undefined) {
    throw new TypeError("allowUnscoredNetwork requires an explicit policy.maxAmountUsd ceiling");
  }
  const { intelligenceOptions, allowUnscoredNetwork, ...gateOptions } = options;
  const integrationOptions = {
    ...gateOptions,
    decisionFile,
    intelligence: options.intelligence ?? createTwzrdIntelligenceProvider({
      ...intelligenceOptions,
      failOpen: false,
      unsupportedNetworkMode: allowUnscoredNetwork ? "observe" : "strict",
    }),
  };
  return {
    twzrdMppIntegration: true as const,
    gate: async (challenge: TwzrdMppIntegrationChallenge) => {
      const evaluation = await evaluateTwzrdMppChallenge(
        { ...challenge, realm: challenge.realm ?? "" },
        integrationOptions,
      );
      return {
        disposition: evaluation.disposition,
        decisionId: evaluation.decision.decisionId,
        intentHash: evaluation.decision.intentHash,
        reasonCodes: evaluation.decision.reasonCodes,
      } as const;
    },
    onFulfillment: createDefaultMppFulfillmentLedgerSink(decisionFile),
    flush: ledger.flush,
  };
}

/**
 * Evaluate an MPP challenge without creating a credential. This is the
 * integration point for payment rails that own credential creation: they can
 * evaluate the challenge, honor a block, then let their existing signer path
 * continue for allow/warn. Unsupported methods and malformed challenges throw.
 */
export async function evaluateTwzrdMppChallenge(
  challenge: MppChallenge,
  options: Omit<MppOnChallengeOptions, "allowUnevaluated">,
): Promise<MppChargeEvaluation> {
  const result = await evaluateMppChallenge(challenge, options, false);
  if (!result) {
    throw new TwzrdMppBlockError(
      "UNEVALUATED_METHOD",
      "[twzrd] MPP challenge was not evaluated",
    );
  }
  return result;
}

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
): (
  challenge: MppChallenge,
  helpers: MppOnChallengeHelpers,
) => Promise<string | undefined> {
  return async (challenge, helpers) => {
    const evaluation = await evaluateMppChallenge(
      challenge,
      options,
      Boolean(options.allowUnevaluated),
    );
    if (!evaluation) return undefined; // explicit opt-out: mppx default flow, ungated
    if (evaluation.disposition === "block")
      throw paymentControlError(evaluation);
    // allow (or warn, when not treated as block): create the credential for the
    // EXACT challenge evaluated.
    return helpers.createCredential();
  };
}

async function evaluateMppChallenge(
  challenge: MppChallenge,
  options: MppOnChallengeOptions,
  allowUnevaluated: boolean,
): Promise<MppChargeEvaluation | undefined> {
  const stateDir = options.stateDir ?? process.env.TWZRD_STATE_DIR;
  const killFilePath = options.killFilePath ?? process.env.KILLSWITCH_KILL_FILE;
  const pauseFilePath = options.pauseFilePath ?? process.env.KILLSWITCH_PAUSE_FILE;
  const sentinel = readSentinelState({
    stateDir: stateDir ?? "./data",
    killFilePath,
    pauseFilePath,
    now: options.now?.(),
  });
  if (sentinel.active) {
    const code =
      sentinel.mode === "kill"
        ? "twzrd_kill_switch"
        : sentinel.mode === "corrupt_pause"
          ? "twzrd_pause_corrupt"
          : "twzrd_payment_paused";
    const refusal = new TwzrdMppBlockError(
      "PAYMENT_CONTROL_BLOCK",
      `[twzrd] ${code}`,
      {
        reasonCodes: [code],
        ...(sentinel.decisionId ? { decisionId: sentinel.decisionId } : {}),
      },
    );
    await persistMppDecision(options, {
      ...(sentinel.decisionId ? { decisionId: sentinel.decisionId } : {}),
      outcome: "block",
      reasonCodes: [code],
      errorCode: refusal.code,
      input: {},
    });
    emitDecision(options, { challenge, refusal });
    throw refusal;
  }

  let intent: PaymentIntent;
  try {
    intent = mppChallengeToIntent(challenge, {
      resourceUrl:
        typeof options.resourceUrl === "function"
          ? options.resourceUrl(challenge)
          : options.resourceUrl,
      method: options.method,
      purpose: options.purpose,
      now: options.now?.(),
    });
  } catch (error) {
    const refusal = asBlockError(error, "MALFORMED_CHALLENGE");
    if (refusal.code === "UNEVALUATED_METHOD" && allowUnevaluated) {
      await persistMppDecision(options, {
        outcome: "warn",
        reasonCodes: ["reputation_unchecked"],
        input: {},
      });
      emitDecision(options, { challenge });
      return undefined;
    }
    await persistMppDecision(options, {
      outcome: "block",
      reasonCodes: [reasonCode(refusal.code)],
      errorCode: refusal.code,
      input: {},
    });
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
      reputationUnchecked: !options.intelligence,
      ttlMs: options.ttlMs,
      now: options.now?.(),
    });
  } catch (error) {
    const refusal = asBlockError(error, "MALFORMED_CHALLENGE");
    await persistMppDecision(options, {
      outcome: "error",
      reasonCodes: ["mpp_evaluation_error"],
      errorCode: refusal.code,
      input: {
        pay_to: intent.payTo,
        resource: intent.resource?.url,
        network: intent.network,
        amount_micro: safeAmountMicro(intent.amount),
      },
    });
    emitDecision(options, { challenge, intent, refusal });
    throw refusal;
  }

  const disposition =
    decision.decision === "block" ||
    (decision.decision === "warn" && isTrueFlag(options.treatWarnAsBlock))
      ? "block"
      : decision.decision;
  if (disposition === "block") {
    const fatalReason = decision.reasonCodes.find((c) => isFatalGateRefusal(c));
    const pauseTarget =
      pauseFilePath ?? (stateDir ? join(stateDir, ".pause") : undefined);
    const rawTripPause = options.tripPauseOnBlockMs ?? process.env.TWZRD_TRIP_PAUSE_ON_BLOCK_MS;
    const tripPauseNum =
      typeof rawTripPause === "number"
        ? rawTripPause
        : rawTripPause == null || rawTripPause === ""
          ? NaN
          : Number(rawTripPause);
    const ttlMs =
      rawTripPause === 0 || rawTripPause === "0"
        ? 0
        : Number.isFinite(tripPauseNum) && tripPauseNum > 0
          ? Math.floor(tripPauseNum)
          : DEFAULT_CAP_PAUSE_WINDOW_MS;
    if (fatalReason && pauseTarget && ttlMs > 0) {
      try {
        writePauseSentinel(pauseTarget, {
          ttlMs,
          reason: fatalReason,
          decisionId: decision.decisionId,
          now: options.now?.(),
        });
      } catch {
        /* best-effort backpressure file write */
      }
    }
  }
  await persistMppDecision(options, {
    decisionId: decision.decisionId,
    outcome: disposition,
    reasonCodes: decision.reasonCodes,
    input: {
      pay_to: intent.payTo,
      resource: intent.resource?.url,
      network: intent.network,
      amount_micro: safeAmountMicro(intent.amount),
    },
  });
  emitDecision(options, { challenge, intent, decision });
  return { intent, decision, disposition };
}

function safeAmountMicro(amount: string): string | undefined {
  try {
    return toMicroUsd(amount).toString();
  } catch {
    return undefined;
  }
}

function reasonCode(code: string): string {
  return code
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .slice(0, 64);
}

async function persistMppDecision(
  options: MppOnChallengeOptions,
  entry: {
    decisionId?: string;
    outcome: "allow" | "warn" | "block" | "error";
    reasonCodes: readonly string[];
    errorCode?: string;
    input: {
      pay_to?: string;
      resource?: string;
      network?: string;
      amount_micro?: string;
    };
  },
): Promise<void> {
  try {
    const file = resolve(options.decisionFile ?? ".twzrd/decisions.jsonl");
    const ledger = sharedFileDecisionLedger(file, { flushBeforeExit: false });
    ledger.record({
      ...(entry.decisionId ? { decision_id: entry.decisionId } : {}),
      outcome: entry.outcome,
      reason_codes: [...entry.reasonCodes],
      policy_version: "mpp-gate.v1",
      input: entry.input,
      signer_invocations: 0,
      ...(entry.errorCode
        ? { error: { code: reasonCode(entry.errorCode) } }
        : {}),
    });
    await ledger.flush();
  } catch {
    throw new TwzrdMppBlockError(
      "DECISION_LOG_UNAVAILABLE",
      "[twzrd] MPP decision could not be durably recorded; refusing payment",
    );
  }
}

function paymentControlError(
  evaluation: MppChargeEvaluation,
): TwzrdMppBlockError {
  return new TwzrdMppBlockError(
    "PAYMENT_CONTROL_BLOCK",
    `[twzrd] mpp_payment_control_${evaluation.decision.decision}:${evaluation.decision.reasonCodes.join(",")} payTo=${evaluation.intent.payTo}`,
    {
      reasonCodes: evaluation.decision.reasonCodes,
      decisionId: evaluation.decision.decisionId,
    },
  );
}

/** Normalize any thrown value into a TwzrdMppBlockError so callers can branch on .code. */
function asBlockError(
  error: unknown,
  fallback: TwzrdMppBlockError["code"],
): TwzrdMppBlockError {
  if (error instanceof TwzrdMppBlockError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new TwzrdMppBlockError(
    fallback,
    `[twzrd] MPP evaluation failed: ${message}`,
  );
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
