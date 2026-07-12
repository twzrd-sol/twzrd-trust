// NOTE: `withTwzrdGuard` (the fetch wrapper) is exported below from ./with-guard.js.
// gate.ts also defines a generic-fn wrapper of the same name; re-exporting both here
// is a duplicate-export collision that esbuild/tsx/Vite reject (tsc silently keeps the
// last one). The fetch wrapper is the documented public API, so we export only that.
export { createTwzrdGate, defaultGate, type TwzrdGate } from "./gate.js";
export { resolveConfig, type ResolvedTwzrdGateConfig } from "./config.js";
export {
  evaluateReadinessCard,
  buildPreflightInput,
  twzrdPreflight,
  twzrdApprovePayment,
  type PolicyEvaluateInput,
} from "./policy.js";
export { payToFromRequirements, priceUsdcFromAmountMicro, pickRequirements } from "./payto.js";
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
export { withTwzrdGuard, type TwzrdGuardOptions } from "./with-guard.js";
export {
  installTwzrdAutoGate,
  type PayWrap,
  type InstallAutoGateOptions,
} from "./auto-gate.js";
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
  type X402ClientLike,
  type X402SelectedRequirements,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type InstallX402ClientHookOptions,
} from "./x402-client-hook.js";
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
