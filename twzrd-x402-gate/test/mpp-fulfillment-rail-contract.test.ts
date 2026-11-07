/**
 * Contract with the ClawRouter Tempo/Solana rail (`@twzrd1111/clawrouter-mpp`), which writes its
 * receipt-reference verification into this package's fulfillment sink.
 *
 * `RailReceiptChainVerification` is copied verbatim from `@twzrd1111/clawrouter-mpp@0.5.0`
 * (`dist/index.d.ts`, `ReceiptChainVerification`). The `satisfies` line fails `npm run typecheck`
 * if the sink input stops accepting the rail's record. The runtime half checks that every reason
 * the rail can send survives the file sink, so a failed verification never reads as "not evaluated".
 *
 * Run: npx tsx test/mpp-fulfillment-rail-contract.test.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./helpers/tmpdir.js";
import { createFileDecisionLedger, type MppFulfillmentLedgerInput } from "../src/decision-ledger-file.js";

type ChainMismatch = "bad_reference_format" | "wrong_network" | "signature_mismatch" | "message_mismatch" | "buyer_signature_missing" | "untrusted_token_program" | "untrusted_mint" | "decimals_mismatch" | "tx_failed" | "no_matching_transfer" | "multiple_matching_transfers" | "amount_mismatch" | "mint_mismatch" | "payee_mismatch" | "payer_mismatch";
type ChainUnverifiedReason = "rpc_unavailable" | "not_finalized" | "no_fetcher" | "non_solana" | "no_signed_transaction" | "splits_unsupported" | "unnormalized_terms" | "unsupported_message_format" | "verifier_error";
type RailReceiptChainVerification = {
  receipt_reference_chain_verified: boolean | null;
  receipt_reference_finalized_slot: number | null;
  receipt_reference_mismatch: ChainMismatch | null;
  receipt_reference_unverified_reason: ChainUnverifiedReason | null;
  receipt_reference_purchase_bound: boolean | null;
  receipt_reference_purchase_bound_reason: "nonce_mismatch" | "no_buyer_nonce" | "chain_unverified" | null;
  receipt_reference_local_acceptance: "accepted" | "refused" | null;
  receipt_reference_refusal_reason: "reference_reused" | "stale_by_local_clock" | null;
};

type SinkEvidence = Pick<MppFulfillmentLedgerInput, keyof RailReceiptChainVerification>;
// Compile-time contract: the rail's record must be assignable to the sink's evidence fields.
const railShapeAccepted = (v: RailReceiptChainVerification): SinkEvidence => v;
void railShapeAccepted;

const MISMATCHES: readonly ChainMismatch[] = ["bad_reference_format", "wrong_network", "signature_mismatch", "message_mismatch", "buyer_signature_missing", "untrusted_token_program", "untrusted_mint", "decimals_mismatch", "tx_failed", "no_matching_transfer", "multiple_matching_transfers", "amount_mismatch", "mint_mismatch", "payee_mismatch", "payer_mismatch"];
const UNVERIFIED: readonly ChainUnverifiedReason[] = ["rpc_unavailable", "not_finalized", "no_fetcher", "non_solana", "no_signed_transaction", "splits_unsupported", "unnormalized_terms", "unsupported_message_format", "verifier_error"];

const base = {
  http_status: 200,
  payment_method: "solana",
  payment_intent: "charge",
  challenge_id: "challenge-rail-contract",
  paid_to: "seller",
  network: "solana:mainnet",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount_atomic: "1000",
  receipt_state: "valid_format",
  receipt_status: "success",
  receipt_method: "solana",
  receipt_reference: "5".repeat(88),
  receipt_timestamp: "2026-11-07T00:00:00Z",
  requested_model: null,
  seller_reported_model: null,
  seller_reported_model_matches_request: null,
  gate: null,
} satisfies Omit<MppFulfillmentLedgerInput, keyof RailReceiptChainVerification>;

const ledger = createFileDecisionLedger(join(tempDir("twzrd-rail-contract-"), "decisions.jsonl"));

for (const reason of MISMATCHES) {
  const evidence: RailReceiptChainVerification = {
    receipt_reference_chain_verified: false,
    receipt_reference_finalized_slot: 1234,
    receipt_reference_mismatch: reason,
    receipt_reference_unverified_reason: null,
    receipt_reference_purchase_bound: false,
    receipt_reference_purchase_bound_reason: "chain_unverified",
    receipt_reference_local_acceptance: "refused",
    receipt_reference_refusal_reason: null,
  };
  const row = ledger.recordMppFulfillment({ ...base, ...evidence });
  assert.equal(row.receipt_reference_chain_verified, false);
  assert.equal(row.receipt_reference_mismatch, reason, `mismatch reason ${reason} is kept`);
  assert.equal(row.receipt_reference_local_acceptance, "refused");
  assert.equal(row.receipt_reference_purchase_bound_reason, "chain_unverified");
}

for (const reason of UNVERIFIED) {
  const row = ledger.recordMppFulfillment({
    ...base,
    receipt_reference_chain_verified: null,
    receipt_reference_mismatch: null,
    receipt_reference_unverified_reason: reason,
  });
  assert.equal(row.receipt_reference_chain_verified, null, "not evaluated stays null");
  assert.equal(row.receipt_reference_mismatch, null);
  assert.equal(row.receipt_reference_unverified_reason, reason, `unverified reason ${reason} is kept`);
}

const verified = ledger.recordMppFulfillment({
  ...base,
  receipt_reference_chain_verified: true,
  receipt_reference_finalized_slot: 99,
  receipt_reference_mismatch: null,
  receipt_reference_purchase_bound: true,
  receipt_reference_local_acceptance: "accepted",
  receipt_reference_refusal_reason: null,
});
assert.equal(verified.receipt_reference_chain_verified, true);
assert.equal(verified.receipt_reference_mismatch, null);
assert.equal(verified.receipt_reference_local_acceptance, "accepted");

const reused = ledger.recordMppFulfillment({
  ...base,
  receipt_reference_local_acceptance: "refused",
  receipt_reference_refusal_reason: "reference_reused",
});
assert.equal(reused.receipt_reference_local_acceptance, "refused");
assert.equal(reused.receipt_reference_refusal_reason, "reference_reused");

await ledger.flush();
console.log("mpp-fulfillment-rail-contract: all assertions passed");
