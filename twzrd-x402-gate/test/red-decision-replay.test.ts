/**
 * RED TEAM — attack class 7 (stale decisions), 8 (replay/tamper) and 9
 * (integrity of the signer-call counting mechanism itself).
 *
 * Headline claim: on REFUSE the signer is invoked ZERO times. Class 9 asks
 * whether the counter can be fooled — if it can, the claim is unproven even
 * where the gate is correct.
 *
 * `DEFECT:` assertions encode CURRENT behavior. Run:
 *   npx tsx test/red-decision-replay.test.ts
 */
import assert from "node:assert/strict";
import {
  assertIntentApproved,
  createDecisionRegistry,
  createLocalDecisionSigner,
  signDecision,
  type PaymentDecision,
} from "../src/decision-token.js";
import { intentHash, type PaymentIntent } from "../src/intent.js";
import { evaluateIntent } from "../src/policy-runtime.js";
import { twzrd, type SpendControlOptions } from "../src/spend-control.js";

type PayFn = NonNullable<SpendControlOptions["pay"]>;

const SOL = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RES = "https://merchant.example/paid";
const T0 = Date.parse("2026-01-01T00:00:00Z");

const INTENT: PaymentIntent = {
  protocol: "x402", network: "solana", asset: USDC, amount: "0.01", payTo: SOL,
  resource: { url: RES, method: "GET" },
};

const codeOf = (fn: () => void): string => {
  try { fn(); return "PASS"; } catch (e) { return (e as { code?: string }).code ?? "THREW"; }
};

async function run() {
  const signer = createLocalDecisionSigner();
  const pem = signer.publicKeyPem;
  const token = await evaluateIntent(INTENT, { signer, now: T0, ttlMs: 60_000 });
  assert.equal(token.decision, "allow");

  /* ---------- 7. stale / swapped decisions all fail closed (PASS — locked in) ---------- */
  const check = (i: PaymentIntent, now = T0 + 1_000, t: PaymentDecision = token) =>
    codeOf(() => assertIntentApproved(i, t, { publicKeyPem: pem, now }));

  assert.equal(check(INTENT), "PASS", "the exact approved intent signs");
  assert.equal(check({ ...INTENT, resource: { url: "https://merchant.example/other", method: "GET" } }),
    "INTENT_HASH_MISMATCH", "a decision minted for resource X cannot pay resource Y");
  assert.equal(check({ ...INTENT, network: "eip155:8453" }),
    "INTENT_HASH_MISMATCH", "a solana decision cannot be reused to pay on eip155");
  assert.equal(check({ ...INTENT, network: "solana-devnet" }),
    "INTENT_HASH_MISMATCH", "nor on a sibling solana network");
  assert.equal(check({ ...INTENT, payTo: SOL.slice(0, -1) + "j" }),
    "INTENT_HASH_MISMATCH", "differs-only-in-last-char payTo is caught");
  assert.equal(check({ ...INTENT, amount: "99.00" }),
    "INTENT_HASH_MISMATCH", "an amount bump after approval is caught");
  assert.equal(check({ ...INTENT, asset: "SOMEOTHERMINT" }),
    "INTENT_HASH_MISMATCH", "an asset swap after approval is caught");
  assert.equal(check(INTENT, T0 + 60_001), "DECISION_EXPIRED", "freshness window is enforced");
  assert.equal(check(INTENT, T0 - 60_000), "PASS",
    "clock skew BACKWARD is not caught: there is no not-before / issuedAt field");

  // signature is a real trust anchor: field tampering and key substitution both refuse
  assert.equal(
    check(INTENT, T0 + 10_000_000, { ...token, expiresAt: new Date(T0 + 9e9).toISOString() }),
    "BAD_SIGNATURE", "extending expiry breaks the signature");
  assert.equal(
    check(INTENT, T0 + 1_000, { ...token, decision: "allow", reasonCodes: ["FORGED"] }),
    "BAD_SIGNATURE", "rewriting reason codes breaks the signature");
  assert.equal(
    codeOf(() => assertIntentApproved(INTENT, token, { publicKeyPem: createLocalDecisionSigner().publicKeyPem, now: T0 + 1 })),
    "BAD_SIGNATURE", "a token signed by another key is refused");
  assert.equal(
    codeOf(() => assertIntentApproved(INTENT, token, { publicKeyPem: "", now: T0 + 1 })),
    "MISSING_VERIFICATION_KEY", "no pinned key means no signing");

  /* ---------- 8a. DEFECT #17 (high): replay is unlimited unless the host opts in ---------- */
  // `registry` is optional; without it the same allow token signs forever inside
  // its TTL. The consume-once claim is a host responsibility the API does not
  // enforce or warn about.
  // SHOULD BE: consume-once by default, with an explicit opt-out.
  {
    const replays = [1, 2, 3, 4, 5].map(() => check(INTENT));
    assert.deepEqual(replays, ["PASS", "PASS", "PASS", "PASS", "PASS"],
      "DEFECT: one allow token authorises unlimited signatures with no registry");
    const registry = createDecisionRegistry();
    const guarded = [1, 2, 3].map(() =>
      codeOf(() => assertIntentApproved(INTENT, token, { publicKeyPem: pem, now: T0 + 1_000, registry })));
    assert.deepEqual(guarded, ["PASS", "DECISION_REPLAYED", "DECISION_REPLAYED"],
      "with a registry, consume-once does hold");
  }

  /* ---------- 8b. DEFECT #18 (medium): an unparseable expiresAt NEVER expires ---------- */
  // `now >= Date.parse(token.expiresAt)` is `now >= NaN`, which is always false.
  // Not attacker-forgeable (the field is signature-covered), but any issuer that
  // emits a non-ISO expiry — a remote decision service, a hand-built token —
  // mints an immortal ALLOW. The last line of defense fails OPEN.
  // SHOULD BE: Number.isNaN(Date.parse(expiresAt)) throws DECISION_EXPIRED.
  {
    const immortal = await signDecision(
      {
        decision: "allow", reasonCodes: ["ALLOW"], intentHash: intentHash(INTENT),
        policyVersion: "twzrd-pc-v1", decisionId: "immortal-1", expiresAt: "not-a-date",
      },
      signer,
    );
    assert.equal(check(INTENT, T0 + 3e11, immortal), "PASS",
      "DEFECT: a token with a garbage expiresAt still authorises signing ~10 years later");
    assert.equal(check(INTENT, T0 + 3e11, { ...immortal, expiresAt: "2026-13-45T99:00:00Z" }),
      "BAD_SIGNATURE", "(a different garbage value at least breaks the signature)");
  }

  /* ---------- 8c. DEFECT #19 (low): a `warn` token is accepted by the binding ---------- */
  // decision-token.ts's own module docstring says the wallet must verify
  // "decision === allow", and the refusal code is literally DECISION_NOT_ALLOW,
  // but the implementation admits `warn` too. Only `block` is refused.
  {
    const warnTok = await evaluateIntent(INTENT, {
      signer, now: T0, ttlMs: 60_000, intelligence: () => ({ decision: "warn" }),
    });
    assert.equal(warnTok.decision, "warn");
    assert.equal(check(INTENT, T0 + 1_000, warnTok), "PASS",
      "DEFECT: assertIntentApproved admits a warn token despite the documented allow-only contract");
    const blockTok = await evaluateIntent(INTENT, {
      signer, now: T0, ttlMs: 60_000, intelligence: () => ({ decision: "block" }),
    });
    assert.equal(check(INTENT, T0 + 1_000, blockTok), "DECISION_NOT_ALLOW", "block is refused");
  }

  /* ---------- 9. can the signer-call counter be fooled? ---------- */
  // A counter that increments on ENTRY, before any await, cannot be evaded by
  // the shape of the call. Drive the same counting signer through four shapes
  // and assert the refuse path stays at exactly 0 in all of them.
  {
    let calls = 0;
    const countingSigner: PayFn = async () => {
      calls += 1; // synchronous, first statement — no async gap to slip through
      return { response: new Response("ok", { status: 200 }) };
    };
    const blockedOpts = {
      fetch: (async () =>
        new Response(
          JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "solana", payTo: SOL, amount: "10000", asset: USDC, resource: RES }] }),
          { status: 402, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      pay: countingSigner,
      preflight: async () => ({ decision: "block" }),
    };

    // (a) plain await
    calls = 0;
    assert.equal((await twzrd.safeFetch(RES, blockedOpts)).verdict, "block");
    assert.equal(calls, 0, "refuse via await: ZERO signer calls");

    // (b) .then() continuation
    calls = 0;
    await twzrd.safeFetch(RES, blockedOpts).then((r) => assert.equal(r.verdict, "block"));
    assert.equal(calls, 0, "refuse via .then(): ZERO signer calls");

    // (c) the signer throws — a caught error must not hide an invocation
    calls = 0;
    const thrower: PayFn = async () => { calls += 1; throw new Error("wallet rejected"); };
    const allowed = { ...blockedOpts, pay: thrower, preflight: async () => ({ decision: "allow" }) };
    await assert.rejects(() => twzrd.safeFetch(RES, allowed), /wallet rejected/);
    assert.equal(calls, 1, "a throwing signer still counts as invoked");
    calls = 0;
    assert.equal((await twzrd.safeFetch(RES, { ...blockedOpts, pay: thrower })).verdict, "block");
    assert.equal(calls, 0, "refuse with a throwing signer: still ZERO");

    // (d) a pass-through wrapper around the signer
    calls = 0;
    const wrapper: PayFn = async (a) => countingSigner(a);
    assert.equal((await twzrd.safeFetch(RES, { ...blockedOpts, pay: wrapper })).verdict, "block");
    assert.equal(calls, 0, "refuse through a wrapper: still ZERO");
    assert.equal((await twzrd.safeFetch(RES, { ...blockedOpts, pay: wrapper, preflight: async () => ({ decision: "allow" }) })).signerInvocations, 1,
      "and the allow path really does reach the wrapped signer exactly once");
  }

  /* ---------- 9b. DEFECT #20 (medium): signerInvocations UNDER-reports on the
   * bind-refuse path. ------------------------------------------------------- */
  // With requireOfferBinding, spend-control calls `prepareBoundPayment` — handing
  // it the url, the full 402 body, the selected requirement, the leaf hash and
  // the memo — BEFORE validating the bind. When the bind then fails, the result
  // reports signerInvocations:0 even though a host callback holding the wallet
  // has already run. The counter measures submitBoundPayment only; "prepare does
  // not sign" is a comment, not an enforced boundary.
  // SHOULD BE: a distinct prepareInvocations count, or bind validated on
  // requirements before any host callback receives payment material.
  {
    let prepared = 0;
    let submitted = 0;
    const r = await twzrd.safeFetch(RES, {
      fetch: (async () =>
        new Response(
          JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "solana", payTo: SOL, amount: "10000", asset: USDC, resource: RES }] }),
          { status: 402, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      maxSpend: "1.00",
      requireOfferBinding: true,
      prepareBoundPayment: async () => {
        prepared += 1;
        return { transactionBase64: Buffer.from("not-a-real-svm-tx").toString("base64") };
      },
      submitBoundPayment: async () => { submitted += 1; return { response: new Response("ok") }; },
    });
    assert.equal(r.verdict, "block");
    assert.equal(r.reason, "bind_mismatch");
    assert.equal(submitted, 0, "the submit boundary is correctly never reached");
    assert.equal(prepared, 1, "DEFECT: a host callback ran with full payment material");
    assert.equal(r.signerInvocations, 0,
      "DEFECT: the refuse reports ZERO invocations while prepareBoundPayment ran once");
  }

  console.log("red-decision-replay.test.ts: ALL PASSED (4 DEFECTS encoded — see DEFECT: comments)");
}

run().catch((e) => {
  console.error("red-decision-replay.test.ts FAILED:", e);
  process.exit(1);
});
