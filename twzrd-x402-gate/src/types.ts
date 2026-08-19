export type TwzrdDecision = "allow" | "warn" | "block";

/**
 * Extended decision used when the payment network is recognized but not scored
 * (e.g. Base/EVM). Distinct from reputation "allow" — never claim TWZRD intel
 * approved an unscored chain payment.
 */
export type TwzrdGateDecision = TwzrdDecision | "unknown";

export type TwzrdReadinessCard = {
  decision?: TwzrdDecision;
  trust_score?: number;
  can_spend?: boolean;
  proof?: unknown;
  caveats?: string[];
  resource_name?: string;
  seller_wallet?: string;
  /** Live server price for the paid trust receipt (0.05 on current server). */
  full_report_price_usdc?: number;
  /** Paid endpoint path to get a full trust receipt, e.g. /v1/intel/trust/{wallet}. */
  paid_trust_endpoint?: string;
  /**
   * Server-issued preflight id (top-level `preflight_id` in the preflight response,
   * surfaced onto the card by twzrdPreflight). Echoed as `x-twzrd-preflight-id` on the
   * paid /v1/intel/trust call for verify->act funnel attribution.
   */
  preflight_id?: number;
};

export type TwzrdPreflightInput = {
  resource_name: string;
  seller_wallet?: string;
  resource_url?: string;
  price_usdc?: number;
  buyer_wallet?: string;
  agent_intent?: string;
  /** Chain context for the payment. Pass-through for server-side context ("solana", "base", etc.). */
  chain?: string;
};

export type TwzrdGateConfig = {
  /** Base URL without trailing slash. Default: TWZRD_INTEL_BASE or https://intel.twzrd.xyz */
  intelBase?: string;
  /** Block when trust_score is below this. Default: 40 */
  preflightMinScore?: number;
  /** decision values that deny payment. Default: ["block"] */
  blockDecisions?: Iterable<string>;
  /** On preflight HTTP/network failure, approve payment (fail-open). Default: false (fail-closed); opt in with TWZRD_FAIL_OPEN=true. */
  failOpen?: boolean;
  /**
   * Deny when the card reports can_spend=false. Default: false (decision-only; opt in with TWZRD_GATE_ON_CAN_SPEND=true).
   * Free-tier preflight returns can_spend=false for most sellers (including
   * well-known ones), so set false to follow the "gate only on decision=block"
   * policy documented for ClawRouter/BlockRun in the twzrd-clawrouter skill.
   */
  gateOnCanSpend?: boolean;
  /**
   * After free preflight, also GET free merchant_card for payTo and refuse
   * when wash_flagged=true. Default: true (trustless step 3 open default).
   * Fail-open if the card is unreachable — never invent wash. Opt out with
   * refuseWashFlagged:false or TWZRD_REFUSE_WASH_FLAGGED=0.
   */
  refuseWashFlagged?: boolean;
  /**
   * Soft cap instead of hard refuse: when wash_flagged and priceUsdc <= this,
   * allow (reason twzrd_wash_capped_*). Above the cap (or unknown price) refuse.
   * Only applies when refuseWashFlagged is true. Env: TWZRD_WASH_MAX_USDC.
   */
  washMaxUsdc?: number;
  /**
   * How to handle payments on networks TWZRD does not reputation-score (Base/EVM/…).
   * - observe (default): allow payment, emit decision=unknown + telemetry
   * - strict: block before signing (policy_action=block)
   * Env: TWZRD_UNSUPPORTED_NETWORK_MODE=observe|strict
   */
  unsupportedNetworkMode?: "observe" | "strict";
  /** Custom fetch (for tests or non-Node runtimes). Default: global fetch */
  fetch?: typeof fetch;
  /**
   * Called when decision="warn" or score_basis="default_no_data" (unknown seller).
   * Use to trigger the paid receipt fetch (0.05 USDC via /v1/intel/trust).
   * Return value is ignored — this is fire-and-forget for upsell/logging.
   * Example: (ctx) => paidFetch(`https://intel.twzrd.xyz${ctx.upsellUrl}`)
   */
  onWarnUpsell?: (ctx: TwzrdUpsellContext) => void | Promise<void>;
  /**
   * Optional run attribution (integration + runId). Seat identity (fork-1
   * metric) is ALWAYS stamped on preflight AND on the paid /v1/intel/trust and
   * /v1/intel/quick receipt fetches:
   *   X-TWZRD-Client: twzrd-x402-gate/<version>
   *   X-Twzrd-Caller: twzrd-x402-gate/<version>
   * When this pair is set, preflight ALSO gets:
   *   X-TWZRD-Integration / X-TWZRD-Run-Id
   * (paid receipt fetches do not — that pair stays preflight-only) and every
   * stamped call narrows X-Twzrd-Caller to:
   *   X-Twzrd-Caller: <integration>@<version>
   * runId is caller-supplied and spoofable — pair with server-side observation.
   */
  attribution?: {
    /** Stable integration label, e.g. "payai-x402-solana-pr38". */
    integration: string;
    /** Unique per-run id (e.g. crypto.randomUUID()). Echo it in your transcript. */
    runId: string;
  };
};

export type TwzrdApproveContext = {
  resourceUrl?: string;
  resourceName?: string;
  sellerWallet?: string;
  payTo?: string;
  priceUsdc?: number;
  buyerWallet?: string;
  agentIntent?: string;
  /** Chain context for the payment ("solana", "base", etc.). Pass-through to preflight. */
  chain?: string;
};

export type TwzrdUpsellContext = {
  sellerWallet: string | undefined;
  trustScore: number | null;
  /** Relative path to the paid trust endpoint, e.g. /v1/intel/trust/{wallet} */
  upsellUrl: string;
  /** Actual price read from the server card (0.05 default) */
  priceUsdc: number;
};

export type TwzrdApprovalResult = {
  approved: boolean;
  /**
   * Card decision when reputation-scored: allow | warn | block.
   * For unscored networks: "unknown" (never a reputation "allow").
   */
  verdict: TwzrdGateDecision;
  /** card.trust_score or null when unavailable / unscored network. */
  score: number | null;
  card: TwzrdReadinessCard;
  reason: string;
  /** true when fail-open allowed payment after preflight error */
  failOpen?: boolean;
  /** Server-issued preflight id, threaded from the preflight for verify->act funnel attribution. */
  preflightId?: number;
  /** Free merchant_card.wash_flagged when fetched; null if unavailable / fail-open */
  washFlagged?: boolean | null;
  /** true when wash_flagged but payment allowed under washMaxUsdc */
  washCapped?: boolean;
  /** Raw payment network (CAIP-2 / x402 wire), when known */
  network?: string;
  /** True when the network identifier is recognized by the gate */
  networkSupported?: boolean;
  /** True only when TWZRD ran Solana behavioral reputation for this payment */
  reputationScored?: boolean;
  /**
   * Policy action for the payment (may allow an unscored network).
   * Distinct from reputation verdict — never confuse policy allow with trust allow.
   */
  policyAction?: "allow" | "block";
};

export type X402PaymentRequirements = {
  payTo?: string;
  pay_to?: string;
  maxAmountRequired?: string;
  amount?: string;
  resource?: string;
  description?: string;
  /** x402 wire field for chain context ("solana", "base-sepolia", "base-mainnet", etc.) */
  network?: string;
  /** Optional asset mint / token address from accepts[] */
  asset?: string;
};

export type X402PaymentRequiredBody = {
  accepts?: Array<Record<string, unknown>>;
  x402Version?: number;
};

export type X402McpPaymentRequest = {
  accepts?: Array<Record<string, unknown>>;
  context?: {
    resource?: string;
    toolName?: string;
    counterparty?: string;
    sellerWallet?: string;
    buyerWallet?: string;
  };
};

/**
 * The REAL `@x402/mcp` (v2.x) onPaymentRequested context shape:
 * `{ toolName, arguments, paymentRequired }` with accepts[] nested under
 * `paymentRequired` — NOT at the top level. Verified against
 * @x402/mcp@2.17.0 dist types (PaymentRequestedContext). twzrdOnPaymentRequested
 * accepts either this or the legacy flat X402McpPaymentRequest shape.
 */
export type X402McpPaymentRequestedContext = {
  /** The tool being called */
  toolName?: string;
  /** The arguments passed to the tool */
  arguments?: Record<string, unknown>;
  /** The payment requirements from the server ({ x402Version, accepts, ... }) */
  paymentRequired?: X402PaymentRequiredBody & Record<string, unknown>;
};
