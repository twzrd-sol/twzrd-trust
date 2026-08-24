// NOTE: `withTwzrdGuard` (the fetch wrapper) is exported below from ./with-guard.js.
// gate.ts also defines a generic-fn wrapper of the same name; re-exporting both here
// is a duplicate-export collision that esbuild/tsx/Vite reject (tsc silently keeps the
// last one). The fetch wrapper is the documented public API, so we export only that.
export { CLIENT_VERSION } from "./version.js";
export { createTwzrdGate, defaultGate, type TwzrdGate } from "./gate.js";
export { resolveConfig, type ResolvedTwzrdGateConfig } from "./config.js";
export {
  evaluateReadinessCard,
  buildPreflightInput,
  twzrdPreflight,
  twzrdApprovePayment,
  type PolicyEvaluateInput,
} from "./policy.js";
export { payToFromRequirements, priceUsdcFromAmountMicro, pickRequirements, TWZRD_FEE_PAYER } from "./payto.js";
export {
  classifyNetwork,
  decideUnsupportedNetwork,
  amountBucket,
  type NetworkClass,
  type NetworkKind,
  type UnsupportedNetworkMode,
  type UnsupportedNetworkDecision,
} from "./network.js";
export type { TwzrdGateDecision } from "./types.js";
export {
  fetchMerchantCard,
  applyWashFlaggedPolicy,
  type TwzrdMerchantCard,
  type WashPolicyInput,
  type WashPolicyResult,
} from "./merchant-card.js";
export { twzrdOnPaymentRequested } from "./mcp-hook.js";
export { wrapFetchWithTwzrdGate } from "./wrap-fetch.js";
export {
  evaluate_x402_resource,
  type EvaluateX402Options,
  type EvaluateX402Result,
} from "./evaluate.js";
export {
  DEFAULT_REQUIRE_RECEIPT_MIN_SPEND_USDC,
  resolveRequireReceiptPolicy,
  shouldAttemptPathAReceipt,
  shouldRequirePathAReceipt,
  type RequireReceiptPolicy,
  type ResolvedRequireReceiptPolicy,
} from "./receipt-policy.js";
export {
  DEFAULT_BUYER_MATERIAL_USDC,
  DEFAULT_BUYER_REQUIRE_RECEIPT,
  DEFAULT_BUYER_ESCALATE_ON_WARN,
  resolveBuyerPathADefaults,
  type BuyerEscalateOnWarn,
  type BuyerPathAFlags,
} from "./buyer-defaults.js";
export { withTwzrdGuard, type TwzrdGuardOptions } from "./with-guard.js";
export {
  installTwzrdAutoGate,
  uninstallTwzrdAutoGate,
  isTwzrdAutoGateDisabled,
  type PayWrap,
  type InstallAutoGateOptions,
  type InstallAutoGateFetchOptions,
  type InstallAutoGateX402Options,
  type InstallAutoGateMppOptions,
  type TwzrdAutoGateCommonOptions,
} from "./auto-gate.js";
export {
  TWZRD_TRUST_GATE_BLOCK_WASH,
  TWZRD_TRUST_GATE_BLOCK_CAN_SPEND,
  TWZRD_TRUST_GATE_BLOCK_DECISION,
  TWZRD_TRUST_GATE_BLOCK_BUDGET,
  toTrustGateBlockReason,
} from "./trust-gate-reason.js";
export {
  attachBlockOutcomeAttestation,
  AUTOGATE_BLOCK_PROOF_SCHEMA,
  AUTOGATE_BLOCK_PROOF_SCHEMA_V1_1,
  AUTOGATE_BLOCK_PROOF_SCHEMA_V1_2,
  buildAutogateBlockProof,
  resolveInstalledPackageVersion,
  type AutogateBlockProof,
  type BuildAutogateBlockProofInput,
  type ExecutionMode,
} from "./block-proof.js";
export {
  safeFetch,
  runAgentcashFetch,
  main as safeFetchMain,
  type SafeFetchOptions,
  type SafeFetchResult,
} from "./safe-fetch.js";
export {
  installTwzrdX402ClientHook,
  twzrdBeforePaymentCreation,
  evaluateBeforePaymentCreation,
  createTwzrdBeforePaymentHook,
  mapX402SolanaRequirements,
  flattenDeclaredResource,
  resourceUrlFromPaymentRequired,
  type X402ClientLike,
  type X402SelectedRequirements,
  type X402DeclaredResource,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type InstallX402ClientHookOptions,
  type X402PaymentControlOptions,
  type X402SolanaBeforePaymentContext,
} from "./x402-client-hook.js";
export {
  RESOURCE_BIND_DOMAIN,
  RESOURCE_BIND_EXTRA_KEY,
  RESOURCE_BIND_MEMO_PREFIX,
  RESOURCE_BIND_MEMO_MAX,
  ZERO_BODY_HASH,
  canonicalResourceUrl,
  resourceBindLeafHash,
  resourceBindMemo,
  memoContainsResourceBind,
  stampResourceBind,
  evaluateResourceBind,
  type BindStrength,
  type ResourceBindReq,
  type ResourceBindDecision,
} from "./resource-bind.js";
export {
  extractSvmMemoFromTransaction,
  extractSvmTransferLegs,
  evaluateResourceBindFromSvmTx,
  evaluateResourceBindLegsFromSvmTx,
  MEMO_PROGRAM_ADDRESS as RESOURCE_BIND_MEMO_PROGRAM,
  type ResourceBindLeafFields,
  type SvmTransferLegs,
} from "./resource-bind-tx.js";
export {
  runGateAdoptionProof,
  main as adoptionProofMain,
  ADOPTION_TRANSCRIPT_SCHEMA,
  ADOPTION_PROOF_SELLER,
  ADOPTION_PROOF_NETWORK,
  ADOPTION_PROOF_RESOURCE,
  type GateAdoptionTranscript,
  type GateAdoptionStep,
  type GateAdoptionAssertions,
  type GateAdoptionLineage,
  type RunGateAdoptionProofOptions,
} from "./adoption-proof.js";
export {
  quickCheck,
  QUICK_PRICE_USDC,
  type QuickCheckResult,
  type QuickCheckOptions,
  type TwzrdTier,
} from "./quick.js";
export {
  createSponsoredX402Fetch,
  type SponsorSettle,
  type SponsoredX402Options,
} from "./sponsored.js";
export type {
  TwzrdDecision,
  TwzrdReadinessCard,
  TwzrdPreflightInput,
  TwzrdGateConfig,
  TwzrdApproveContext,
  TwzrdApprovalResult,
  TwzrdUpsellContext,
  X402PaymentRequirements,
  X402PaymentRequiredBody,
  X402McpPaymentRequest,
  X402McpPaymentRequestedContext,
} from "./types.js";

/* ── TWZRD Payment Control (protocol-neutral authorization core) ── */
export {
  canonicalJson,
  intentHash,
  toMicroUsd,
  fromMicroUsd,
  INTENT_HASH_PREFIX,
  type PaymentIntent,
  type PaymentProtocol,
} from "./intent.js";
export {
  assertIntentApproved,
  createDecisionRegistry,
  createLocalDecisionSigner,
  createSeededDecisionSigner,
  decisionPreimage,
  MAX_CITED_OUTCOMES,
  newDecisionId,
  normalizeCitedOutcomes,
  signDecision,
  verifyDecisionSignature,
  TwzrdIntentBindingError,
  type AssertIntentApprovedOptions,
  type BindingErrorCode,
  type DecisionConstraints,
  type DecisionRegistry,
  type DecisionSigner,
  type PaymentDecision,
  type PaymentDecisionVerdict,
} from "./decision-token.js";
export {
  buildBlockedNeverSignedAttestation,
  buildOutcomeAttestation,
  computeDecisionOutcomeLeafV1,
  DECISION_OUTCOME_V1_DOMAIN,
  verifyOutcomeAttestationSignature,
  type DecisionOutcomeAttestation,
  type DecisionOutcomeFields,
  type OutcomeKind,
  type OutcomeVerdict,
} from "./outcome-attestation.js";
export {
  createMemorySpendLedger,
  evaluateIntent,
  POLICY_VERSION,
  TWZRD_BUDGET_EXCEEDED,
  type CounterpartyIntelligence,
  type EvaluateIntentOptions,
  type IntelligenceProvider,
  type Mandate,
  type SpendLedger,
  type SpendPolicy,
} from "./policy-runtime.js";
export {
  ap2CheckoutToIntent,
  x402RequirementsToIntent,
  type Ap2Cart,
  type Ap2UserMandate,
  type X402IntentContext,
} from "./intent-adapters.js";
export {
  createTwzrdMppOnChallenge,
  mppChallengeToIntent,
  mppChallengeDigest,
  NATIVE_SOL_CURRENCY,
  TwzrdMppBlockError,
  type MppChallenge,
  type MppIntentContext,
  type MppOnChallengeHelpers,
  type MppOnChallengeOptions,
  type MppSolanaChargeRequest,
} from "./mpp-hook.js";
export {
  approvalToIntelligence,
  counterpartyKnownFromApproval,
  createTwzrdIntelligenceProvider,
  intentAmountToPriceUsd,
  type TwzrdIntelligenceOptions,
} from "./intelligence.js";
// Optional resource-server settle guard (merchant policy on the payer).
// Core product remains the buyer gate. Attaches to onBeforeSettle; advisory + fail-open.
export {
  createTwzrdSettleGuard,
  defaultExtractPayer,
  extractSvmPayerFromTransaction,
  twzrdPayerScreen,
  toPayaiVerifyResult,
  type SettleGuardContext,
  type SettleGuardAbort,
  type SettleGuardResult,
  type PayerScreen,
  type ScreenFn,
  type GetPayerFn,
  type SettleGuardOptions,
} from "./seller-hook.js";
