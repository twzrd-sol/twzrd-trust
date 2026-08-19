/**
 * Payment Control follow-up — review hardening.
 *
 * One suite per blocker raised in review of the follow-up PR. Each test fails
 * against the pre-fix code:
 *
 *   1. exactly-one signer/secret was not enforced (both -> signer silently won)
 *   2. any non-empty string became an Ed25519 seed via a single SHA-256
 *   3. known:true was derived from reputationScored, which is true for ANY
 *      scored Solana path — including a wallet never observed — so the
 *      unknownCounterparty policy (which fires only on known === false) could
 *      never trigger.
 *
 * Run: npx tsx test/payment-control-hardening.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  installTwzrdX402ClientHook,
  type BeforePaymentCreationContext,
  type X402ClientLike,
} from "../src/x402-client-hook.js";
import {
  createLocalDecisionSigner,
  createSeededDecisionSigner,
} from "../src/decision-token.js";
import {
  approvalToIntelligence,
  counterpartyKnownFromApproval,
  intentAmountToPriceUsd,
} from "../src/intelligence.js";
import type { TwzrdApprovalResult } from "../src/types.js";

const STRONG_SECRET = randomBytes(32).toString("hex"); // openssl rand -hex 32

function mockClient() {
  const client: X402ClientLike = {
    onBeforePaymentCreation() {
      return client;
    },
  };
  return client;
}

function throwsWith(fn: () => unknown, needle: string): void {
  assert.throws(fn, (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    assert.ok(
      msg.toLowerCase().includes(needle.toLowerCase()),
      `expected error to mention ${JSON.stringify(needle)}, got: ${msg}`,
    );
    return true;
  });
}

/** Build an approval whose card carries the given trust_score_basis caveat. */
function approvalWithBasis(
  basis: string | null,
  reputationScored = true,
): TwzrdApprovalResult {
  const caveats = ["price: $0.05/req"];
  if (basis) caveats.push(`trust_score_basis: ${basis} — server prose here.`);
  return {
    approved: true,
    verdict: "warn",
    score: 45,
    reason: "test",
    reputationScored,
    card: { decision: "warn", trust_score: 45, caveats },
  } as TwzrdApprovalResult;
}

async function run() {
  /* ── 1. Exactly one of signer / secret ─────────────────────────────── */
  {
    const signer = await createLocalDecisionSigner();

    // BOTH: must be rejected outright. Previously `signer` silently won, so an
    // operator who set `secret` could believe decisions were signed by a key
    // that was never signing them.
    throwsWith(
      () =>
        installTwzrdX402ClientHook(mockClient(), {
          paymentControl: { signer, secret: STRONG_SECRET } as never,
        }),
      "exactly one",
    );

    // NEITHER: must be rejected — unsigned decisions are unverifiable.
    throwsWith(
      () =>
        installTwzrdX402ClientHook(mockClient(), {
          paymentControl: {} as never,
        }),
      "exactly one",
    );

    // Each alone is accepted.
    assert.ok(
      installTwzrdX402ClientHook(mockClient(), { paymentControl: { signer } }),
    );
    assert.ok(
      installTwzrdX402ClientHook(mockClient(), {
        paymentControl: { secret: STRONG_SECRET },
      }),
    );
  }

  /* ── 2. Secret must be real key material, not a passphrase ─────────── */
  {
    // The decision public key is published, so a guessable secret is an offline
    // brute-force target: derive each candidate's pubkey, compare, forge ALLOW.
    // Too little key material (passphrases, or genuine randomness under 32 bytes).
    for (const weak of [
      "hunter2",
      "correct horse battery staple",
      "twzrd-decision-secret",
      randomBytes(16).toString("hex"), // real randomness, only 16 bytes
    ]) {
      throwsWith(() => createSeededDecisionSigner(weak), "high-entropy");
    }

    // A memorable passphrase LONG ENOUGH to clear 32 decoded bytes and using
    // only base64-alphabet characters: length + per-byte entropy both pass, so
    // ONLY the base64 round-trip guard rejects it. This is the exact forgery
    // target — a guessable secret whose published pubkey can be brute-forced.
    for (const passphrase of [
      "MySuperSecretPaymentControlSigningKey2026Production",
      "twzrdPaymentControlDecisionSigningKeyDoNotShareEver",
    ]) {
      throwsWith(() => createSeededDecisionSigner(passphrase), "high-entropy");
    }

    // Right LENGTH, no entropy. Note "aaaa…" is itself valid hex, so a length
    // check alone would wave it through — hence the separate entropy floor.
    for (const patterned of ["a".repeat(64), "00".repeat(32)]) {
      throwsWith(() => createSeededDecisionSigner(patterned), "entropy");
    }

    // 32 bytes of real randomness is accepted, deterministic, and yields a
    // public key for verifiers — the secret itself never leaves the issuer.
    const a = createSeededDecisionSigner(STRONG_SECRET);
    const b = createSeededDecisionSigner(STRONG_SECRET);
    assert.equal(a.publicKeyPem, b.publicKeyPem, "same secret -> same keypair");
    assert.ok(a.publicKeyPem.includes("BEGIN PUBLIC KEY"));
    assert.ok(!a.publicKeyPem.includes(STRONG_SECRET));

    // Domain separation: the seed is HKDF'd, not a bare SHA-256 of the secret,
    // so the signing key cannot collide with any other key derived from it.
    const distinct = createSeededDecisionSigner(randomBytes(32).toString("hex"));
    assert.notEqual(a.publicKeyPem, distinct.publicKeyPem);

    // base64 material is accepted too.
    assert.ok(
      createSeededDecisionSigner(randomBytes(32).toString("base64")).publicKeyPem,
    );
  }

  /* ── 3. known: mapped from trust_score_basis, NOT reputationScored ─── */
  {
    // A wallet with zero observed history still returns reputationScored:true
    // (Solana WAS scored). It must NOT be reported as a known counterparty.
    const unknown = approvalWithBasis("corpus_teaser_v1:insufficient_free_evidence");
    assert.equal(counterpartyKnownFromApproval(unknown), false);
    assert.equal(approvalToIntelligence(unknown).known, false);

    // Evidence-backed basis -> genuinely known.
    const known = approvalWithBasis("corpus_teaser_v1:provider_reputation_v1");
    assert.equal(counterpartyKnownFromApproval(known), true);
    assert.equal(approvalToIntelligence(known).known, true);

    // Absent basis -> "we cannot say", which is NOT the same as "we looked and
    // found nothing". Only `false` may drive the unknownCounterparty policy.
    assert.equal(counterpartyKnownFromApproval(approvalWithBasis(null)), undefined);

    // Unrecognized basis -> ambiguous, never silently treated as evidence.
    assert.equal(
      counterpartyKnownFromApproval(approvalWithBasis("corpus_teaser_v9:some_future_basis")),
      undefined,
    );

    // Unscored network (Base/EVM, Stripe deposit addresses): no reputation ran,
    // so the recipient is unknown-to-us — never `false`, never `true`.
    assert.equal(
      counterpartyKnownFromApproval(
        approvalWithBasis("corpus_teaser_v1:provider_reputation_v1", false),
      ),
      undefined,
    );
  }

  /* ── 4. Amount guard at the API boundary ───────────────────────────── */
  {
    assert.equal(intentAmountToPriceUsd("0.05"), 0.05);
    assert.equal(intentAmountToPriceUsd("0"), 0);
    for (const bad of ["", "abc", "NaN", "Infinity", "-1", "1e400"]) {
      throwsWith(() => intentAmountToPriceUsd(bad), "finite");
    }
  }

  console.log("payment-control-hardening.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("payment-control-hardening.test.ts FAILED:", e);
  process.exit(1);
});
