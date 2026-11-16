// Offline check of a signed V7 receipt with twzrd-receipt-verifier: the leaf
// hash of the preimage and an ed25519 signature against the issuer key the
// package pins. verifyReceipt (lib/guarded-fetch.mjs) calls verify(), which is
// synchronous and does no I/O.
import { readFileSync } from "node:fs";

import verifier from "twzrd-receipt-verifier";

import { verifyReceipt } from "./guarded-fetch.mjs";

const { CURRENT_RECEIPT_PUBKEY, CURRENT_RECEIPT_SIGNING_KEY_ID } = verifier;

/**
 * A receipt the paid trust endpoint issued. The same bytes are published at
 * docs/proofs/intel-receipt/receipt.json in this repository.
 */
export const RECEIPT_FIXTURE = new URL("../fixtures/intel-receipt-v7.json", import.meta.url);

const CASES = [
  { name: "as_issued", label: "as issued", edit: null },
  {
    name: "score_plus_1",
    label: "score +1",
    edit: (preimage) => {
      preimage.score += 1;
    },
  },
  {
    // V7 signs the freshness window. Both fields move together so the window
    // stays self-consistent (recheck_after = timestamp + staleness_days); the
    // leaf no longer matches the signed one.
    name: "fresh_for_30_more_days",
    label: "fresh for 30 more days",
    edit: (preimage) => {
      preimage.staleness_days += 30;
      preimage.recheck_after_unix += 30 * 86400;
    },
  },
];

export function loadReceipt() {
  return JSON.parse(readFileSync(RECEIPT_FIXTURE, "utf8"));
}

/** Verify the receipt as issued, then two edited copies: the score, and the freshness window. */
export function checkReceiptOffline({ receipt = loadReceipt(), onReceiptVerified } = {}) {
  return {
    kind: receipt.kind,
    subject: receipt.preimage.agent_id,
    score: receipt.preimage.score,
    issuedAt: new Date(receipt.preimage.timestamp_unix * 1000).toISOString(),
    trustedPubkey: CURRENT_RECEIPT_PUBKEY,
    keyId: CURRENT_RECEIPT_SIGNING_KEY_ID,
    cases: CASES.map(({ name, label, edit }) => {
      const copy = structuredClone(receipt);
      if (edit) edit(copy.preimage);
      const event = verifyReceipt(copy, { onReceiptVerified });
      return {
        name,
        label,
        expectValid: edit === null,
        valid: event.valid,
        leafValid: event.leafValid,
        signatureValid: event.signatureValid,
        errors: event.errors,
      };
    }),
  };
}
