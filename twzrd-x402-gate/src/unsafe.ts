/**
 * Unsafe-grade surface, deliberately kept OFF the package root.
 *
 * Everything here skips a control the safe API enforces (e.g. intent matching
 * without decision-signature verification, so forged tokens pass when the
 * remaining fields match). Import from `twzrd-x402-gate/unsafe` only when
 * token provenance is guaranteed by other means. Prefer the root-exported
 * `assertIntentApproved` everywhere else.
 */
export {
  unsafeAssertIntentApprovedWithoutSignature,
  type UnsafeAssertIntentApprovedOptions,
} from "./decision-token.js";
