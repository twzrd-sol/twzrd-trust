/**
 * FOREIGN-CLIENT PROOF — the "agents do not sign blind" claim, asserted against
 * a real third-party x402 client instead of a TWZRD-authored mock.
 *
 * Why this file exists: every other hook test in this suite drives a local
 * mock of X402ClientLike, and even test/x402-official-compat.test.ts — which
 * does import the real @x402/core client — substitutes a fake scheme that
 * throws before any signing machinery runs. So nothing in the suite has ever
 * observed a SIGNER on either path. A block-path proof whose signer could not
 * have been called on the allow path either is vacuous.
 *
 * Here the whole payment path is genuine installed third-party code
 * (@x402/fetch wrapFetchWithPayment -> @x402/core x402Client -> @x402/svm
 * ExactSvmScheme -> @solana/kit transaction signing). The only instrument is a
 * counting TransactionPartialSigner. Offline: loopback origin + loopback
 * Solana JSON-RPC + a stubbed TWZRD intel fetch. No wallet, no chain, no egress.
 *
 * The harness lives in examples/foreign-client-proof.ts so the standalone
 * transcript (`npm run foreign-client-proof`) and this test assert the exact
 * same named checks — one definition, no drift.
 *
 * Run: npx tsx test/foreign-client-proof.test.ts
 */
import assert from "node:assert/strict";

import {
  runForeignClientProof,
  verifyForeignClientProof,
  verifyNegativeControl,
  verifyPostApprovalTamper,
  type Check,
} from "../examples/foreign-client-proof.js";

function assertChecks(checks: Check[], expectedNames: string[]) {
  assert.deepEqual(
    checks.map((c) => c.name),
    expectedNames,
    "check set drifted — update the test and the transcript together",
  );
  for (const c of checks) {
    assert.equal(c.ok, true, `${c.name} FAILED (${c.detail})`);
  }
}

async function run() {
  // 1. REFUSE — priority #1: a gate refusal reaches the signer ZERO times.
  {
    const proof = await runForeignClientProof("refuse");
    assert.equal(proof.signerInvocations, 0, "REFUSED PAYMENT REACHED THE SIGNER");
    assert.equal(proof.signerCalls.length, 0);
    assert.equal(proof.originSignedRequests, 0, "a paid request reached the merchant after a refusal");
    assert.equal(proof.status, null, "refusal must not return a settled response");
    assert.match(String(proof.error), /Payment creation aborted: \[twzrd\] twzrd_can_spend_false/);
    assertChecks(verifyForeignClientProof(proof), [
      "refuse/gate_evaluated_once",
      "refuse/gate_refused",
      "refuse/signer_never_invoked",
      "refuse/nothing_was_signed",
      "refuse/no_paid_request_reached_merchant",
      "refuse/no_payload_reached_merchant",
      "refuse/refusal_surfaced_to_caller",
      "refuse/refusal_names_the_merchant",
    ]);
  }

  // 2. ALLOW — the signer IS invoked, exactly once, on exactly what was approved.
  {
    const proof = await runForeignClientProof("allow");
    assert.equal(proof.signerInvocations, 1, "an approved payment must be signable");
    const signed = proof.signerCalls[0];
    assert.equal(signed.amountMicro, proof.requirement.amount, "signed amount != approved amount");
    assert.equal(signed.destinationAta, proof.expectedDestinationAta, "signed recipient != approved payTo");
    assert.equal(signed.mint, proof.requirement.asset, "signed asset != approved asset");
    assert.equal(proof.decisions[0]?.network, proof.originAccepted?.network, "network changed between decision and wire");
    assert.equal(proof.status, 200);
    assertChecks(verifyForeignClientProof(proof), [
      "allow/gate_evaluated_once",
      "allow/gate_approved",
      "allow/signer_invoked_exactly_once",
      "allow/one_message_signed",
      "allow/signed_amount_matches_approved",
      "allow/signed_recipient_matches_approved",
      "allow/signed_asset_matches_approved",
      "allow/signed_authority_is_the_buyer",
      "allow/merchant_received_the_approved_requirement",
      "allow/settled_once",
    ]);
  }

  // 3. TOCTOU CONTROL — a hook registered AFTER TWZRD rewrites payTo. @x402/core
  //    hands the SAME mutable requirement object to the scheme, and
  //    installTwzrdX402ClientHook evaluates a shallow copy of it
  //    (pickReq, src/x402-client-hook.ts:202), so the swap lands. This asserts
  //    the limit honestly AND that the harness detects the divergence — a proof
  //    that could not see a recipient swap would not be worth running.
  {
    const tamper = await runForeignClientProof("allow", { tamperAfterGate: true });
    assert.equal(tamper.decisions[0]?.payTo, tamper.requirement.payTo, "gate must have approved the original merchant");
    assert.notEqual(tamper.signerCalls[0]?.destinationAta, tamper.expectedDestinationAta, "the post-approval swap did not land");
    assert.ok(
      verifyForeignClientProof(tamper).some((c) => c.name === "allow/signed_recipient_matches_approved" && !c.ok),
      "the binding check failed to notice a recipient swap",
    );
    assertChecks(verifyPostApprovalTamper(tamper), [
      "tamper/gate_approved_the_original_merchant",
      "tamper/later_hook_diverted_the_signature",
      "tamper/proof_detects_the_diversion",
    ]);
  }

  // 4. NEGATIVE CONTROL — same flagged merchant, TWZRD not installed. Must sign.
  //    Without this, the zero in case 1 could be an unsignable fixture.
  {
    const control = await runForeignClientProof("refuse", { installGate: false });
    assert.equal(control.decisions.length, 0, "control must run with no gate");
    assert.equal(control.signerInvocations, 1, "control did not sign — case 1's zero proves nothing");
    assert.equal(control.status, 200, "control did not settle — case 1's zero proves nothing");
    assertChecks(verifyNegativeControl(control), [
      "control/gate_absent",
      "control/signer_reachable_without_gate",
      "control/flagged_merchant_would_have_been_paid",
    ]);
  }

  console.log("foreign-client-proof.test.ts: ALL PASSED (real @x402 client, signer counted on both paths)");
}

run().catch((e) => {
  console.error("foreign-client-proof.test.ts FAILED:", e);
  process.exit(1);
});
