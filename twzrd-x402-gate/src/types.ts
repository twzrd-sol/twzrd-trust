export type TwzrdDecision = "allow" | "warn" | "block";

export type TwzrdReadinessCard = {
  decision?: TwzrdDecision;
  trust_score?: number;
  can_spend?: boolean;
  proof?: unknown;
  caveats?: string[];
  resource_name?: string;
  seller_wallet?: string;
};

export type TwzrdPreflightInput = {
  resource_name: string;
  seller_wallet?: string;
  resource_url?: string;
  price_usdc?: number;
  buyer_wallet?: string;
  agent_intent?: string;
};

export type TwzrdGateConfig = {
  /** Base URL without trailing slash. Default: TWZRD_INTEL_BASE or https://intel.twzrd.xyz */
  intelBase?: string;
  /** Block when trust_score is below this. Default: 40 */
  preflightMinScore?: number;
  /** decision values that deny payment. Default: ["block"] */
  blockDecisions?: Iterable<string>;
  /** On preflight HTTP/network failure, approve payment. Default: true */
  failOpen?: boolean;
  /**
   * Deny when the card reports can_spend=false. Default: true.
   * Free-tier preflight returns can_spend=false for most sellers (including
   * well-known ones), so set false to follow the "gate only on decision=block"
   * policy documented for ClawRouter/BlockRun in the twzrd-clawrouter skill.
   */
  gateOnCanSpend?: boolean;
  /** Custom fetch (for tests or non-Node runtimes). Default: global fetch */
  fetch?: typeof fetch;
};

export type TwzrdApproveContext = {
  resourceUrl?: string;
  resourceName?: string;
  sellerWallet?: string;
  payTo?: string;
  priceUsdc?: number;
  buyerWallet?: string;
  agentIntent?: string;
};

export type TwzrdApprovalResult = {
  approved: boolean;
  card: TwzrdReadinessCard;
  reason: string;
  /** true when fail-open allowed payment after preflight error */
  failOpen?: boolean;
};

export type X402PaymentRequirements = {
  payTo?: string;
  pay_to?: string;
  maxAmountRequired?: string;
  amount?: string;
  resource?: string;
  description?: string;
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
