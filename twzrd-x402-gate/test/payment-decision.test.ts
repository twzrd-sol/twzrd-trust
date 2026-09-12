/**
 * twzrd.payment_decision.v1 — the portable decision receipt and its verifier.
 *
 * Everything here is offline and deterministic: a fixed test-vector key, a
 * fixed clock, no network. A relying party in another language can replay the
 * fixture file (test/fixtures/payment-decision-v1-vectors.json) and must reach
 * the same accept/reject verdicts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "./helpers/tmpdir.js";

import {
  createLocalDecisionSigner,
  createSeededDecisionSigner,
  type PaymentDecision,
} from "../src/decision-token.js";
import { evaluateIntent } from "../src/policy-runtime.js";
import { resourceBindLeafHash, type ResourceBindReq } from "../src/resource-bind.js";
import type { PaymentIntent } from "../src/intent.js";
import {
  PAYMENT_DECISION_DECISIONS,
  PAYMENT_DECISION_DOMAIN,
  PAYMENT_DECISION_FIELDS,
  PAYMENT_DECISION_REASON_CODES,
  PAYMENT_DECISION_SCHEMA,
  challengeHashV1,
  decisionFromApproval,
  issuePaymentDecisionRecord,
  mainVerify,
  merchantFromChallenge,
  paymentDecisionPreimage,
  paymentDecisionRecordFromToken,
  primaryReasonCode,
  toCaip2Network,
  TwzrdPaymentDecisionError,
  verifyPaymentDecisionRecord,
  type PaymentDecisionRecordV1,
} from "../src/payment-decision.js";

/* ---------------------------------------------------------------- */
/* Fixed inputs                                                       */
/* ---------------------------------------------------------------- */

const MERCHANT = "MerchantWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const RESOURCE = "https://api.merchant.example/v1/weather?units=metric&city=berlin";

/** A selected x402 accepts[] entry, with the extras a real 402 carries. */
const CHALLENGE = {
  scheme: "exact",
  network: "solana",
  payTo: MERCHANT,
  asset: USDC,
  maxAmountRequired: "10000",
  resource: RESOURCE,
  description: "Weather, per call",
  mimeType: "application/json",
  maxTimeoutSeconds: 60,
} satisfies ResourceBindReq & Record<string, unknown>;

/** Clock for every verification below: well before the fixture expiry. */
const NOW = Date.parse("2026-09-09T00:00:00.000Z");
const FIXTURE_EXPIRES = "2030-01-01T00:00:00.000Z";

/** Test-vector key: derived, never a real deployment key. */
const VECTOR_SECRET = createHash("sha256")
  .update("twzrd.payment_decision.v1 test vectors — NOT A DEPLOYMENT KEY")
  .digest("hex");
const vectorSigner = createSeededDecisionSigner(VECTOR_SECRET, "twzrd-pd-v1-vectors");
const VECTOR_PEM = vectorSigner.publicKeyPem;

const FIXTURE_PATH = new URL("./fixtures/payment-decision-v1-vectors.json", import.meta.url);

const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code);
const has = (r: { errors: Array<{ code: string }> }, c: string) => codes(r).includes(c);
const verify = (rec: unknown, extra: Record<string, unknown> = {}) =>
  verifyPaymentDecisionRecord(rec, { publicKeyPem: VECTOR_PEM, now: NOW, ...extra });

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    protocol: "x402",
    network: SOLANA_MAINNET,
    asset: USDC,
    amount: "0.01",
    payTo: MERCHANT,
    resource: { url: RESOURCE, method: "GET" },
    ...overrides,
  };
}

async function run() {
  /* ---------- 1. fixtures: byte-exact regeneration + acceptance ---------- */
  const vectorInputs = {
    allow: { decision: "allow", reason_code: "ALLOW", evidence_id: "00000000-0000-4000-8000-00000000a110" },
    block: { decision: "block", reason_code: "WASH_FLAGGED", evidence_id: "00000000-0000-4000-8000-00000000b10c" },
    warn: { decision: "warn", reason_code: "INTEL_WARN", evidence_id: "00000000-0000-4000-8000-00000000fa11" },
    unavailable: {
      decision: "unavailable",
      reason_code: "INTEL_UNAVAILABLE",
      evidence_id: "00000000-0000-4000-8000-000000000dead",
    },
  } as const;

  const regenerated: Record<string, PaymentDecisionRecordV1> = {};
  for (const [name, v] of Object.entries(vectorInputs)) {
    regenerated[name] = await issuePaymentDecisionRecord(
      { challenge: CHALLENGE, ...v, expires_at: FIXTURE_EXPIRES },
      vectorSigner,
    );
  }

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
    public_key_pem: string;
    challenge: typeof CHALLENGE;
    records: Record<string, PaymentDecisionRecordV1>;
  };
  assert.equal(fixture.public_key_pem, VECTOR_PEM, "fixture key must be the derived test-vector key");
  assert.deepEqual(fixture.challenge, CHALLENGE);
  assert.deepEqual(fixture.records, regenerated,
    "fixture records must regenerate byte-for-byte (Ed25519 is deterministic; a drift here is a freeze break)");

  for (const [name, rec] of Object.entries(fixture.records)) {
    const r = verify(rec, { challenge: CHALLENGE });
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r.errors)}`);
    assert.equal(r.decision, name);
    assert.equal(r.checks.challenge_bound, true);
    assert.deepEqual(Object.keys(rec).sort(), [...PAYMENT_DECISION_FIELDS].sort());

    // The record carries what the spec allows and nothing else.
    const text = JSON.stringify(rec);
    assert.equal(text.includes("/v1/weather"), false, "resource path must not appear");
    assert.equal(text.includes("units=metric"), false, "query must not appear");
    assert.equal(text.includes("10000"), false, "amount must not appear");
    assert.equal(text.includes(USDC), false, "asset must not appear");
    assert.equal(rec.merchant.origin, "https://api.merchant.example");
    assert.equal(rec.merchant.pay_to, MERCHANT);
    assert.equal(rec.network, SOLANA_MAINNET, "wire alias 'solana' is emitted as CAIP-2");
    assert.equal(rec.scheme, "exact");
    assert.equal(rec.challenge_hash, resourceBindLeafHash(CHALLENGE),
      "challenge_hash IS the resource-bind v1 leaf — one binding, not two");
    // Without a challenge the binding is unchecked, never passed.
    assert.equal(verify(rec).checks.challenge_bound, null);
  }

  /* ---------- 2. allow / block / warn from real DecisionTokens ---------- */
  const signer = createLocalDecisionSigner({ keyId: "ops-test" });
  const opts = { signer, now: NOW, ttlMs: 120_000 };
  const allowTok = await evaluateIntent(intent(), opts);
  const blockTok = await evaluateIntent(intent({ amount: "50" }), { ...opts, policy: { maxAmountUsd: "1" } });
  const warnTok = await evaluateIntent(intent(), { ...opts, intelligence: () => ({ decision: "warn" }) });
  assert.equal(allowTok.decision, "allow");
  assert.equal(blockTok.decision, "block");
  assert.equal(warnTok.decision, "warn");

  for (const tok of [allowTok, blockTok, warnTok]) {
    const rec = await paymentDecisionRecordFromToken(tok, CHALLENGE, signer);
    const r = verifyPaymentDecisionRecord(rec, { publicKeyPem: signer.publicKeyPem, now: NOW, challenge: CHALLENGE });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.decision, tok.decision);
    assert.equal(rec.evidence_id, tok.decisionId, "evidence_id is the token's decisionId");
    assert.equal(rec.expires_at, tok.expiresAt, "record expires with the token");
    assert.equal(rec.signature.key_id, "ops-test");
  }
  const blockRec = await paymentDecisionRecordFromToken(blockTok, CHALLENGE, signer);
  assert.equal(blockRec.reason_code, "POLICY_MAX_AMOUNT",
    `block token reasons ${JSON.stringify(blockTok.reasonCodes)} → primary technical code`);
  const warnRec = await paymentDecisionRecordFromToken(warnTok, CHALLENGE, signer);
  assert.equal(warnRec.reason_code, "INTEL_WARN");

  // A block token whose FIRST reason is a warn code still yields a block code.
  assert.equal(primaryReasonCode("block", ["INTEL_WARN", "UNKNOWN_ABOVE_LIMIT"]), "UNKNOWN_ABOVE_LIMIT");
  assert.throws(() => primaryReasonCode("block", ["INTEL_WARN"]), TwzrdPaymentDecisionError);
  assert.throws(() => primaryReasonCode("allow", ["WASH_FLAGGED"]), TwzrdPaymentDecisionError);
  // Records never mint a token verdict that is not allow|warn|block.
  await assert.rejects(
    paymentDecisionRecordFromToken({ ...allowTok, decision: "unavailable" as never }, CHALLENGE, signer),
    TwzrdPaymentDecisionError,
  );

  /* ---------- 3. unavailable is first-class ---------- */
  const unavailable = fixture.records.unavailable;
  {
    const r = verify(unavailable, { challenge: CHALLENGE });
    assert.equal(r.ok, true);
    assert.equal(r.decision, "unavailable");
    assert.notEqual(r.decision, "block");
  }
  for (const code of ["INTEL_UNAVAILABLE", "INTEL_TIMEOUT", "NETWORK_NOT_SCORED", "EVALUATOR_ERROR"] as const) {
    const rec = await issuePaymentDecisionRecord(
      { challenge: CHALLENGE, decision: "unavailable", reason_code: code, evidence_id: "u-1", expires_at: FIXTURE_EXPIRES },
      vectorSigner,
    );
    assert.equal(verify(rec).ok, true, code);
  }

  // The gate's own fail-closed shape (verdict block, reason twzrd_fail_closed)
  // and fail-open shape (verdict warn, reason twzrd_fail_open) both project to
  // unavailable — the SAME fact for a relying party.
  assert.deepEqual(
    decisionFromApproval({ verdict: "block", approved: false, reason: "twzrd_fail_closed (fetch failed)", failOpen: false }),
    { decision: "unavailable", reason_code: "INTEL_UNAVAILABLE" },
  );
  assert.deepEqual(
    decisionFromApproval({ verdict: "warn", approved: true, reason: "twzrd_fail_open", failOpen: true }),
    { decision: "unavailable", reason_code: "INTEL_UNAVAILABLE" },
  );
  assert.deepEqual(
    decisionFromApproval({ verdict: "unknown", approved: true, reason: "network_not_scored", reputationScored: false }),
    { decision: "unavailable", reason_code: "NETWORK_NOT_SCORED" },
  );
  assert.deepEqual(
    decisionFromApproval({ verdict: "unknown", approved: false, reason: "network_not_scored", reputationScored: false }),
    { decision: "unavailable", reason_code: "NETWORK_NOT_SCORED" },
    "strict-mode local refuse on an unscored network is still 'no verdict', not block",
  );
  assert.deepEqual(
    decisionFromApproval({ verdict: "unknown", approved: false, reason: "twzrd_wash_flagged", washFlagged: true, reputationScored: false }),
    { decision: "block", reason_code: "WASH_FLAGGED" },
    "a wash refuse on an unscored network is a real verdict",
  );
  assert.deepEqual(
    decisionFromApproval({ verdict: "block", approved: false, reason: "twzrd_wash_flagged", washFlagged: true }),
    { decision: "block", reason_code: "WASH_FLAGGED" },
  );
  assert.deepEqual(
    decisionFromApproval({ verdict: "block", approved: false, reason: "twzrd_decision_block" }),
    { decision: "block", reason_code: "INTEL_BLOCK" },
  );
  assert.deepEqual(
    decisionFromApproval({ verdict: "block", approved: false, reason: "twzrd_budget_exceeded POLICY_MAX_AMOUNT" }),
    { decision: "block", reason_code: "twzrd_budget_exceeded" },
  );
  assert.deepEqual(
    decisionFromApproval({ verdict: "warn", approved: true, reason: "twzrd_warn_allowed" }),
    { decision: "warn", reason_code: "INTEL_WARN" },
  );
  assert.deepEqual(
    decisionFromApproval({ verdict: "allow", approved: true, reason: "twzrd_allow" }),
    { decision: "allow", reason_code: "ALLOW" },
  );

  /* ---------- 4. unavailable is NOT block ---------- */
  {
    // (a) Flip the decision on a genuine unavailable record.
    const asBlock = { ...unavailable, decision: "block" };
    const r = verify(asBlock);
    assert.equal(r.ok, false);
    assert.ok(has(r, "unavailable_as_block"), codes(r).join());
    assert.ok(has(r, "bad_signature"));
    assert.equal(r.decision, null, "a rejected record yields no decision");
    assert.equal(r.checks.decision_coherent, false);

    // (b) The issuer refuses to mint it in the first place.
    await assert.rejects(
      issuePaymentDecisionRecord(
        { challenge: CHALLENGE, decision: "block", reason_code: "INTEL_UNAVAILABLE", evidence_id: "x", expires_at: FIXTURE_EXPIRES },
        vectorSigner,
      ),
      (e: unknown) =>
        e instanceof TwzrdPaymentDecisionError && e.errors.some((x) => x.code === "unavailable_as_block"),
    );

    // (c) Even a VALIDLY SIGNED block-with-unavailable-reason is rejected:
    // coherence is not something a signature can override.
    const unsigned = {
      ...unavailable,
      decision: "block" as const,
      signature: { alg: "ed25519" as const, key_id: vectorSigner.keyId },
    };
    const sig = Buffer.from(await vectorSigner.sign(paymentDecisionPreimage(unsigned))).toString("base64");
    const signedLie = { ...unsigned, signature: { ...unsigned.signature, sig } };
    const rl = verify(signedLie);
    assert.equal(rl.checks.signature, true, "signature itself verifies…");
    assert.equal(rl.ok, false, "…and the record is still rejected");
    assert.deepEqual(codes(rl), ["unavailable_as_block"]);

    // (d) The converse lie: unavailable wearing a block reason.
    const rc = verify({ ...unavailable, reason_code: "WASH_FLAGGED" });
    assert.ok(has(rc, "decision_conflict"));
    // (e) Claiming both via a second field.
    const rb = verify({ ...unavailable, verdict: "block" });
    assert.ok(has(rb, "unknown_field"));
    assert.equal(rb.ok, false);
    // (f) No decision at all.
    const { decision: _drop, ...noDecision } = unavailable;
    void _drop;
    const rn = verify(noDecision);
    assert.ok(has(rn, "decision_missing"));
    assert.equal(rn.ok, false);
    // (g) "Both" as a list, or any non-enum value.
    assert.ok(has(verify({ ...unavailable, decision: ["block", "unavailable"] }), "decision_invalid"));
    assert.ok(has(verify({ ...unavailable, decision: "BLOCK" }), "decision_invalid"));
    assert.ok(has(verify({ ...unavailable, decision: "unknown" }), "decision_invalid"),
      "the gate's internal 'unknown' verdict is not a v1 decision; it maps to unavailable");
    // (h) An allow record wearing a block decision is a plain conflict, not unavailable_as_block.
    const ra = verify({ ...fixture.records.allow, decision: "block" });
    assert.ok(has(ra, "decision_conflict"));
    assert.equal(has(ra, "unavailable_as_block"), false);
  }

  /* ---------- 5. expiry ---------- */
  {
    const late = Date.parse(FIXTURE_EXPIRES);
    const r = verify(fixture.records.allow, { now: late });
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r), ["expired"], "at the instant of expiry the record is already expired");
    assert.equal(verify(fixture.records.allow, { now: late - 1 }).ok, true);
    // Token TTL flows through.
    const shortTok = await evaluateIntent(intent(), { ...opts, ttlMs: 1000 });
    const shortRec = await paymentDecisionRecordFromToken(shortTok, CHALLENGE, signer);
    assert.equal(verifyPaymentDecisionRecord(shortRec, { publicKeyPem: signer.publicKeyPem, now: NOW + 999 }).ok, true);
    assert.ok(has(verifyPaymentDecisionRecord(shortRec, { publicKeyPem: signer.publicKeyPem, now: NOW + 1000 }), "expired"));
    // Malformed expiry fails closed, and never with a "not expired" check passing.
    const bad = verify({ ...fixture.records.allow, expires_at: "2030-01-01 00:00:00" });
    assert.ok(has(bad, "invalid_field"));
    assert.equal(bad.checks.not_expired, false);
    assert.ok(has(verify({ ...fixture.records.allow, expires_at: "2030-01-01T00:00:00+02:00" }), "invalid_field"),
      "offsets are rejected: v1 is UTC-Z only");
  }

  /* ---------- 6. tampering ---------- */
  {
    const base = fixture.records.block;
    const otherHash = createHash("sha256").update("another challenge").digest("hex");
    const th = verify({ ...base, challenge_hash: otherHash }, { challenge: CHALLENGE });
    assert.equal(th.ok, false);
    assert.ok(has(th, "bad_signature"), "hash swap breaks the signature");
    assert.ok(has(th, "challenge_hash_mismatch"), "…and is caught by recomputation when the challenge is known");
    assert.equal(th.checks.challenge_bound, false);
    // Without the challenge, the signature alone still catches it.
    assert.ok(has(verify({ ...base, challenge_hash: otherHash }), "bad_signature"));

    const tp = verify({ ...base, merchant: { ...base.merchant, pay_to: "AttackerWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" } },
      { challenge: CHALLENGE });
    assert.ok(has(tp, "bad_signature") && has(tp, "merchant_mismatch"));

    assert.ok(has(verify({ ...base, network: "eip155:8453" }, { challenge: CHALLENGE }), "network_mismatch"));
    assert.ok(has(verify({ ...base, scheme: "upto" }, { challenge: CHALLENGE }), "scheme_mismatch"));
    assert.ok(has(verify({ ...base, evidence_id: "someone-elses-id" }), "bad_signature"));
    assert.ok(has(verify({ ...base, expires_at: "2031-01-01T00:00:00.000Z" }), "bad_signature"), "expiry is signed");
    assert.ok(has(verify({ ...base, signature: { ...base.signature, key_id: "other" } }), "bad_signature"), "key_id is signed");

    // A record for a DIFFERENT challenge (same merchant, different amount) does not bind to ours.
    const dearer = { ...CHALLENGE, maxAmountRequired: "20000" };
    const dearerRec = await issuePaymentDecisionRecord(
      { challenge: dearer, decision: "allow", reason_code: "ALLOW", evidence_id: "d-1", expires_at: FIXTURE_EXPIRES },
      vectorSigner,
    );
    assert.equal(verify(dearerRec).ok, true);
    assert.ok(has(verify(dearerRec, { challenge: CHALLENGE }), "challenge_hash_mismatch"));

    // Wrong key, keyed map, and no key at all.
    const stranger = createLocalDecisionSigner();
    assert.ok(has(verifyPaymentDecisionRecord(base, { publicKeyPem: stranger.publicKeyPem, now: NOW }), "bad_signature"));
    assert.equal(verifyPaymentDecisionRecord(base, { publicKeys: { [base.signature.key_id]: VECTOR_PEM }, now: NOW }).ok, true);
    assert.ok(has(verifyPaymentDecisionRecord(base, { publicKeys: { "some-other-key": VECTOR_PEM }, now: NOW }), "missing_verifier_key"));
    const nokey = verifyPaymentDecisionRecord(base, { now: NOW });
    assert.equal(nokey.ok, false);
    assert.deepEqual(codes(nokey), ["missing_verifier_key"]);
    assert.equal(nokey.decision, null);
    // Garbage in.
    assert.ok(has(verify("nope"), "not_an_object"));
    assert.ok(has(verify(null), "not_an_object"));
    assert.ok(has(verify([base]), "not_an_object"));
    assert.ok(has(verify({}), "decision_missing"));
    assert.ok(has(verify({ ...base, schema: "twzrd.payment_decision.v2" }), "schema_mismatch"));
  }

  /* ---------- 7. forbidden content ---------- */
  {
    const base = fixture.records.warn;
    for (const [key, value] of Object.entries({
      score: 72,
      trust_score: 72,
      resource_url: "https://api.merchant.example/v1/weather?units=metric",
      amount: "10000",
      authorization: "Bearer sk_live_abcdefghijklmnop",
      payload: "eyJ4NDAyVmVyc2lvbiI6MX0=",
      private_key: "-----BEGIN PRIVATE KEY-----",
      wallet: MERCHANT,
      x_payment: "eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QifQ==",
    })) {
      const r = verify({ ...base, [key]: value });
      assert.equal(r.ok, false, key);
      assert.ok(has(r, "forbidden_field"), `${key}: ${codes(r).join()}`);
    }
    // Innocuous key name, forbidden value shape.
    const url = verify({ ...base, note: "see https://api.merchant.example/v1/weather?units=metric" });
    assert.ok(has(url, "unknown_field") && has(url, "forbidden_content"));
    const b64 = verify({ ...base, note: "eyJ4NDAyVmVyc2lvbiI6MX0=" });
    assert.ok(has(b64, "forbidden_content"), "base64 JSON is a raw payload");
    const pem = verify({ ...base, note: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----" });
    assert.ok(has(pem, "forbidden_content"));
    assert.ok(pem.errors.every((e) => !e.message.includes("MIIB")), "a finding never echoes the secret");
    // Forbidden shapes in ALLOWED fields.
    assert.ok(has(verify({ ...base, evidence_id: "https://intel.twzrd.xyz/e/1?x=1" }), "invalid_field"));
    assert.ok(has(verify({ ...base, merchant: { ...base.merchant, origin: "https://api.merchant.example/v1/weather" } }), "invalid_field"),
      "origin must be bare");
    assert.ok(has(verify({ ...base, merchant: { ...base.merchant, origin: "https://api.merchant.example/?q=1" } }), "invalid_field"));
    assert.ok(has(verify({ ...base, merchant: { ...base.merchant, origin: "https://user:pw@api.merchant.example" } }), "invalid_field"));
    assert.ok(has(verify({ ...base, merchant: { ...base.merchant, pay_to: "5".repeat(88) } }), "forbidden_content"),
      "a 64-byte base58 blob is key material, not an address");
    assert.ok(has(verify({ ...base, merchant: { ...base.merchant, resource: RESOURCE } }), "forbidden_field"));
    assert.ok(has(verify({ ...base, signature: { ...base.signature, payload: "x" } }), "forbidden_field"));
    // The producer refuses to mint forbidden content too.
    await assert.rejects(
      issuePaymentDecisionRecord(
        { challenge: { ...CHALLENGE, payTo: "5".repeat(88) }, decision: "allow", reason_code: "ALLOW", evidence_id: "x", expires_at: FIXTURE_EXPIRES },
        vectorSigner,
      ),
      TwzrdPaymentDecisionError,
    );
    await assert.rejects(
      issuePaymentDecisionRecord(
        { challenge: CHALLENGE, decision: "allow", reason_code: "ALLOW", evidence_id: "https://x.example/?a=1", expires_at: FIXTURE_EXPIRES },
        vectorSigner,
      ),
      TwzrdPaymentDecisionError,
    );
  }

  /* ---------- 8. challenge normalization ---------- */
  {
    const h = challengeHashV1(CHALLENGE);
    assert.equal(h, resourceBindLeafHash(CHALLENGE));
    // The leaf's requirements_hash covers the resource string AS SERVED, so even a
    // reordered query is a different challenge. What the agent saw is what is committed.
    const reordered = { ...CHALLENGE, resource: "https://api.merchant.example/v1/weather?city=berlin&units=metric" };
    assert.notEqual(challengeHashV1(reordered), h, "resource is committed byte-exact");
    assert.notEqual(challengeHashV1({ ...CHALLENGE, resource: `${RESOURCE}#frag` }), h);
    const noisy: ResourceBindReq = { ...CHALLENGE, description: "different", maxTimeoutSeconds: 5 } as ResourceBindReq;
    assert.equal(challengeHashV1(noisy), h, "fields outside the six do not enter the hash");
    assert.notEqual(challengeHashV1({ ...CHALLENGE, maxAmountRequired: "10001" }), h);
    assert.notEqual(challengeHashV1({ ...CHALLENGE, network: SOLANA_MAINNET }), h,
      "the hash commits to the RAW network string the agent saw");
    assert.notEqual(challengeHashV1({ ...CHALLENGE, resource: "https://api.merchant.example/v1/weather?units=metric&city=paris" }), h);
    assert.notEqual(challengeHashV1({ ...CHALLENGE, scheme: "upto" }), h);
    assert.notEqual(challengeHashV1({ ...CHALLENGE, payTo: "AttackerWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }), h);
    // amount / pay_to aliases are accepted (x402 v1 vs v2 wire).
    const { maxAmountRequired, payTo, ...rest } = CHALLENGE;
    assert.equal(challengeHashV1({ ...rest, amount: maxAmountRequired, pay_to: payTo }), h);
    // Under-specified challenges cannot be committed to.
    for (const drop of ["payTo", "maxAmountRequired", "resource", "network", "scheme"] as const) {
      const { [drop]: _x, ...partial } = CHALLENGE;
      void _x;
      assert.throws(() => challengeHashV1(partial), new RegExp(drop === "maxAmountRequired" ? "amount" : drop));
    }
    assert.throws(() => challengeHashV1({ ...CHALLENGE, resource: "not a url" }));

    assert.deepEqual(merchantFromChallenge(CHALLENGE), { origin: "https://api.merchant.example", pay_to: MERCHANT });
    assert.deepEqual(merchantFromChallenge({ ...CHALLENGE, resource: "HTTPS://Api.Merchant.Example:443/x" }).origin,
      "https://api.merchant.example", "origin is WHATWG-normalized");
    assert.throws(() => merchantFromChallenge({ ...CHALLENGE, resource: "https://u:p@api.merchant.example/x" }), /userinfo/);

    assert.equal(toCaip2Network("solana"), SOLANA_MAINNET);
    assert.equal(toCaip2Network("Solana"), SOLANA_MAINNET);
    assert.equal(toCaip2Network("base"), "eip155:8453");
    assert.equal(toCaip2Network("eip155:84532"), "eip155:84532");
    assert.equal(toCaip2Network(SOLANA_MAINNET), SOLANA_MAINNET);
    assert.throws(() => toCaip2Network("polygon"), /not CAIP-2/);
    // A challenge with an unmappable network needs an explicit CAIP-2.
    await assert.rejects(
      issuePaymentDecisionRecord(
        { challenge: { ...CHALLENGE, network: "polygon" }, decision: "allow", reason_code: "ALLOW", evidence_id: "p", expires_at: FIXTURE_EXPIRES },
        vectorSigner,
      ),
      /not CAIP-2/,
    );
    const polygon = await issuePaymentDecisionRecord(
      { challenge: { ...CHALLENGE, network: "polygon" }, network: "eip155:137", decision: "allow", reason_code: "ALLOW", evidence_id: "p", expires_at: FIXTURE_EXPIRES },
      vectorSigner,
    );
    assert.equal(polygon.network, "eip155:137");
    assert.ok(has(verify(polygon, { challenge: { ...CHALLENGE, network: "polygon" } }), "network_unmappable"),
      "an unmappable challenge network is reported, never silently passed");
  }

  /* ---------- 9. preimage + JSON schema agree with the code ---------- */
  {
    const rec = fixture.records.allow;
    const pre = paymentDecisionPreimage(rec).toString("utf8");
    assert.ok(pre.startsWith(PAYMENT_DECISION_DOMAIN));
    assert.equal(pre.includes(rec.signature.sig), false, "signature bytes are not in the preimage");
    assert.ok(pre.includes(`"key_id":"${rec.signature.key_id}"`), "key_id IS covered");
    assert.ok(pre.includes('"alg":"ed25519"'), "alg IS covered");
    assert.notEqual(PAYMENT_DECISION_DOMAIN, "twzrd-decision-v1\n", "distinct domain from DecisionToken");

    const schema = JSON.parse(
      readFileSync(new URL("../../docs/schemas/twzrd.payment_decision.v1.schema.json", import.meta.url), "utf8"),
    );
    assert.equal(schema.title, PAYMENT_DECISION_SCHEMA);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), [...PAYMENT_DECISION_FIELDS].sort());
    assert.deepEqual([...schema.required].sort(), [...PAYMENT_DECISION_FIELDS].sort());
    assert.deepEqual(schema.properties.decision.enum, [...PAYMENT_DECISION_DECISIONS]);
    assert.deepEqual([...schema.properties.reason_code.enum].sort(), Object.keys(PAYMENT_DECISION_REASON_CODES).sort());
    assert.deepEqual(Object.keys(schema.properties.merchant.properties), ["origin", "pay_to"]);
    assert.deepEqual(Object.keys(schema.properties.signature.properties), ["alg", "key_id", "sig"]);
    // The conditional reason_code enums in the schema mirror the code's table exactly.
    for (const clause of schema.allOf as Array<{ if: any; then: any }>) {
      const d = clause.if.properties.decision.const as string;
      const expected = Object.entries(PAYMENT_DECISION_REASON_CODES)
        .filter(([, ds]) => (ds as readonly string[]).includes(d)).map(([c]) => c).sort();
      assert.deepEqual([...clause.then.properties.reason_code.enum].sort(), expected, `schema allOf for ${d}`);
    }
  }

  /* ---------- 10. CLI ---------- */
  {
    const dir = tempDir("twzrd-pd-");
    const recPath = join(dir, "record.json");
    const pemPath = join(dir, "issuer.pem");
    const chPath = join(dir, "challenge.json");
    writeFileSync(recPath, JSON.stringify(fixture.records.block));
    writeFileSync(pemPath, VECTOR_PEM);
    writeFileSync(chPath, JSON.stringify(CHALLENGE));
    // Fixture expiry is 2030; the CLI uses the real clock, which is before that.
    let out = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
    try {
      assert.equal(await mainVerify([recPath, "--pubkey", pemPath, "--challenge", chPath]), 0);
      assert.ok(out.includes("ACCEPT") && out.includes("decision: block"), out);
      out = "";
      assert.equal(await mainVerify(["--json", recPath, "--pubkey", pemPath]), 0);
      assert.equal(JSON.parse(out).decision, "block");
      out = "";
      writeFileSync(recPath, JSON.stringify({ ...fixture.records.unavailable, decision: "block" }));
      assert.equal(await mainVerify([recPath, "--pubkey", pemPath]), 1);
      assert.ok(out.includes("REJECT") && out.includes("unavailable_as_block"), out);
      assert.equal(await mainVerify([recPath]), 2, "usage without a key");
      assert.equal(await mainVerify([join(dir, "missing.json"), "--pubkey", pemPath]), 2);
    } finally {
      (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
    }
  }

  console.log("payment-decision.test.ts: ALL PASSED (10 sections)");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
