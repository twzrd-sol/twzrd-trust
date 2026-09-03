/*
 * twzrd-log-verifier — offline verifier for the TWZRD Receipt Transparency
 * log. Spec: docs/transparency-log.md in twzrd-sol/twzrd-trust.
 *
 * Verifies, with no trust in TWZRD's servers or code, that:
 *  - a receipt leaf is included in a signed tree head (inclusion proof);
 *  - a newer tree head only appended to an older one (consistency proof);
 *  - a tree head was anchored on Solana by the published authority;
 *  - two tree heads that contradict each other are portable proof of
 *    log misbehavior (equivocation).
 */
export {
  MAX_PROOF_DEPTH,
  HASH_LEN,
  KECCAK_EMPTY,
  assertHashBackend,
  emptyRoot,
  leafHash,
  nodeHash,
  merkleRoot,
  inclusionProof,
  consistencyProof,
  verifyInclusion,
  verifyConsistency,
} from "./merkle.js";
export {
  STH_DOMAIN,
  PUBKEY_LEN,
  SIGNATURE_LEN,
  MAX_LOG_ID_UTF8,
  encodeSthPreimage,
  verifySth,
  signSth,
  type SthFields,
  type SignedTreeHead,
  type SthVerifyResult,
} from "./sth.js";
export {
  ANCHOR_MEMO_PREFIX,
  MEMO_PROGRAM_IDS,
  DEFAULT_RPC_URL,
  parseAnchorMemo,
  formatAnchorMemo,
  anchorMatchesSth,
  fetchAnchorTransaction,
  verifyAnchor,
  type AnchorPayload,
  type AnchorVerifyResult,
  type FetchedAnchorTx,
} from "./anchor.js";
export { checkEquivocation, type EquivocationResult } from "./equivocation.js";
export { hexToBytes, bytesToHex, b58decode, b58encode } from "./util.js";

/**
 * v0.1 pins: the STH signing key is the existing receipt issuer key (also at
 * https://intel.twzrd.xyz/.well-known/twzrd-receipt-pubkey). Ships baked-in —
 * the same paranoid out-of-band pinning model twzrd-receipt-verifier uses for
 * the cNFT genesis authority. Override with --pubkey / explicit argument.
 */
// The current issuer key (key_id twzrd-receipt-ed25519-v2). The v1 key was
// retired 2026-09-02 and is verify-only, so it can never sign an STH.
export const DEFAULT_STH_PUBKEY = "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS";
export const DEFAULT_LOG_DESCRIPTOR_URL =
  "https://intel.twzrd.xyz/.well-known/twzrd-log";
