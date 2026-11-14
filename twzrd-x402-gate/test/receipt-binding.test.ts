/**
 * requireLogInclusion binds the receipt before it asks the log.
 *
 * A log proof says a leaf is in the log. These tests hold the rule that the
 * fields printed beside that leaf are the ones the issuer signed: the gate
 * recomputes the leaf from the receipt's preimage, requires `receipt.leaf` to
 * equal it, and requires the issuer's Ed25519 signature over it under the
 * pinned key. A receipt whose score, or any other signed field, was changed is
 * denied even though its leaf is still in the log and its proof still
 * verifies.
 *
 * Real data: a receipt the paid trust endpoint issued and the proof the log
 * served for it (test/helpers/receipts.ts), checked with the real offline
 * verifier from the sibling workspace.
 *
 * Run: npx tsx --test test/receipt-binding.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { evaluate_x402_resource } from "../src/evaluate.js";
import {
  evaluateLogInclusion,
  resolveRequireLogInclusionPolicy,
  type LogInclusionVerdict,
} from "../src/log-inclusion.js";
import {
  RECEIPT_ISSUER_KEY_ID,
  RECEIPT_ISSUER_PUBKEY,
  verifyReceiptBinding,
} from "../src/receipt-binding.js";
import * as index from "../src/index.js";
import type { X402PaymentRequirements } from "../src/types.js";
import { verifyLogInclusion } from "../../twzrd-log-verifier/src/client.js";
import { DEFAULT_STH_PUBKEY } from "../../twzrd-log-verifier/src/index.js";
import {
  REAL_LEAF,
  REAL_LOG_INCLUSION,
  REAL_RECEIPT,
  realReceiptWith,
  signTestReceipt,
  TEST_RECEIPT_PUBKEY,
  testLeaf,
} from "./helpers/receipts.js";

const SELLER = "SeLLeRWa11et1111111111111111111111111111111";
const REQS = {
  payTo: SELLER, maxAmountRequired: "50000", resource: "https://seller.example/paid", network: "solana",
} as X402PaymentRequirements;
const WARN = { decision: "warn", trust_score: 45, can_spend: false, recommended_cap_usdc: 1000 };
const INVALID = /^twzrd_log_inclusion_receipt_invalid \(/;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const preflight = (async () =>
  json({ readiness_card: WARN, wash_flagged: false, confidence: "full" })) as unknown as typeof fetch;

/** The documented wiring: the real offline verifier over the whole paid response. */
function offlineVerifier() {
  const calls: Array<{ receipt: unknown; ctx: { response: unknown; leaf?: string } }> = [];
  const fn = async (receipt: unknown, ctx: { response: unknown; leaf?: string }) => {
    calls.push({ receipt, ctx });
    return verifyLogInclusion(ctx.response, DEFAULT_STH_PUBKEY);
  };
  return Object.assign(fn, { calls });
}

function pathA(receipt: unknown, policy: Record<string, unknown> = {}, block: unknown = REAL_LOG_INCLUSION) {
  const verifier = offlineVerifier();
  return evaluate_x402_resource("https://seller.example/paid", REQS, {
    fetch: preflight,
    autoReceipt: true,
    x402Fetch: (async () =>
      json({ tx: "TX_PAID", twzrd_receipt: receipt, ...(block ? { log_inclusion: block } : {}) })) as unknown as typeof fetch,
    requireLogInclusion: { verifier, ...policy } as never,
  }).then((result) => ({ result, verifier }));
}

/** One change to each field the leaf carries, each leaving the receipt's leaf and signature as issued. */
const SIGNED_FIELD_CHANGES: Array<[string, Record<string, unknown>]> = [
  ["score raised", { score: 99 }],
  ["score lowered", { score: 0 }],
  ["agent_id", { agent_id: SELLER }],
  ["confidence_bps", { confidence_bps: 10000 }],
  ["timestamp_unix (with its recheck moved to match)", { timestamp_unix: 1794627728, recheck_after_unix: 1794886928 }],
  ["payer", { payer: "Cswv9ZWHwzv3rypAeW99HBqksKJMmbZdV4FxFYRwymAQ" }],
  ["settlement_tx tail (anchor moved to match)", {
    settlement_tx: "5Lb8pTStADxWTjKevYNQMtobMAZhkMjofH6y6JW9aeRh4YgHeHTMbDK8KQEnSY9iD9hAEfBCWcGpg2fFytrNrJwM",
    settlement_anchor: "4b51456e53593969443968414566424357634770673266467974724e724a774d",
  }],
  ["settlement_anchor alone", { settlement_anchor: "00".repeat(32) }],
  ["reputation_score", { reputation_score: 900 }],
  ["reputation_confidence_bps", { reputation_confidence_bps: 9000 }],
  ["reputation_score_version", { reputation_score_version: "intel_renorm_v9" }],
  ["reputation_feature_window_start_unix", { reputation_feature_window_start_unix: 1 }],
  ["reputation_data_quality", { reputation_data_quality: "full" }],
  ["staleness_days (with its recheck moved to match)", { staleness_days: 30, recheck_after_unix: 1794627727 + 30 * 86400 }],
  ["recheck_after_unix alone", { recheck_after_unix: 1894886927 }],
  ["score_decay_model", { score_decay_model: "none" }],
  ["domain downgraded to V6", { domain: "TWZRD:AO_REPUTATION_RECEIPT_V6" }],
  ["domain downgraded to V5", { domain: "TWZRD:AO_REPUTATION_RECEIPT_V5" }],
];

test("the index exports the binding check and the pinned issuer key", () => {
  assert.equal(index.verifyReceiptBinding, verifyReceiptBinding);
  assert.equal(index.RECEIPT_ISSUER_PUBKEY, "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS");
  assert.equal(RECEIPT_ISSUER_PUBKEY, index.RECEIPT_ISSUER_PUBKEY);
  assert.equal(RECEIPT_ISSUER_KEY_ID, "twzrd-receipt-ed25519-v2");
});

test("receipts the issuer signed bind under the default pin: V7, the V7 example, and a V6 receipt", () => {
  const real = verifyReceiptBinding(REAL_RECEIPT);
  assert.deepEqual(real, { ok: true, leaf: REAL_LEAF, version: "v7", pubkey: RECEIPT_ISSUER_PUBKEY });

  const fuzz = JSON.parse(readFileSync(new URL("./fixtures/x402-malformed-fuzz.json", import.meta.url), "utf8")) as {
    baselines: Record<string, string>;
  };
  const example = verifyReceiptBinding(JSON.parse(fuzz.baselines.v7_receipt));
  assert.equal(example.ok, true, example.ok ? "" : example.error);
  assert.equal(example.ok && example.leaf, "c801861f2c4a44e1af29f098cbaeb78ed5ba3a67393309402a2145b8b72e0688");

  // The issuer's published V6 sample receipt.
  const v6 = verifyReceiptBinding({
    version: "v6",
    leaf: "0x696bab7f6778236b86c8a88cd537924813331cceaccc99b0a1a4b2eaca934e30",
    preimage: {
      domain: "TWZRD:AO_REPUTATION_RECEIPT_V6", agent_id: "11111111111111111111111111111111", score: 72,
      attention_score: null, confidence_bps: 8000, timestamp_unix: 1748736000,
      payer: "11111111111111111111111111111111",
      settlement_anchor: "63656970742d6e6f2d7265616c2d736574746c656d656e742d74782d30303031", version: "v6",
      reputation_score: null, reputation_confidence_bps: null, reputation_score_version: "intel_renorm_v1_1",
      reputation_feature_window_start_unix: null, reputation_data_quality: "example",
      recheck_after_unix: 1748995200, staleness_days: 3,
      score_decay_model: "step:<=7d=1.0,<=30d=0.8,<=90d=0.5,>90d=0.25",
      settlement_tx: "EXAMPLE-sample-receipt-no-real-settlement-tx-0001",
    },
    signature: "5Qvodd8wALaDhJ9fSYUFaYy4Zs18vEt8rswA8HPKBkK96m52TVTnDC8tWmbwyYzxFVQqU5kegLSJk7a9PkA8uLG2",
  });
  assert.deepEqual(v6, {
    ok: true, leaf: "696bab7f6778236b86c8a88cd537924813331cceaccc99b0a1a4b2eaca934e30", version: "v6",
    pubkey: RECEIPT_ISSUER_PUBKEY,
  });
});

test("the leaf this package recomputes is the one a separately written builder produces", () => {
  const shapes: Array<Record<string, unknown>> = [
    {},
    { score: 0, confidence_bps: 0, reputation_score: -5, reputation_confidence_bps: 0 },
    { score: 65535, confidence_bps: 10000, reputation_score: null, reputation_confidence_bps: null,
      reputation_score_version: null, reputation_feature_window_start_unix: null, reputation_data_quality: null },
    { agent_id: "agent é ✓", reputation_data_quality: "", payer: "house-marker-payer", staleness_days: 0,
      recheck_after_unix: 1790000000 },
    { settlement_tx: "short-tx" },
  ];
  for (const version of ["v7", "v6"] as const) {
    for (const shape of shapes) {
      const receipt = signTestReceipt(shape, version);
      const bound = verifyReceiptBinding(receipt, [TEST_RECEIPT_PUBKEY]);
      assert.equal(bound.ok, true, `${version} ${JSON.stringify(shape)}: ${bound.ok ? "" : bound.error}`);
      assert.equal(bound.ok && bound.leaf, testLeaf(receipt.preimage).toString("hex"));
      assert.equal(bound.ok && bound.version, version);
    }
  }
});

test("the key comes from the pin, never from the receipt", () => {
  const mine = signTestReceipt();
  // Genuine for the test key, and it says so itself. The default pin is the issuer key.
  const underDefault = verifyReceiptBinding(mine);
  assert.deepEqual(underDefault, {
    ok: false, error: "receipt signature does not verify under the pinned receipt issuer key",
  });
  // Naming the issuer key on the receipt changes nothing.
  const relabelled = { ...mine, signing_pubkey: RECEIPT_ISSUER_PUBKEY, key_id: RECEIPT_ISSUER_KEY_ID };
  assert.equal(verifyReceiptBinding(relabelled).ok, false);
  assert.equal(verifyReceiptBinding(mine, [TEST_RECEIPT_PUBKEY]).ok, true);
  assert.equal(verifyReceiptBinding(mine, [RECEIPT_ISSUER_PUBKEY, TEST_RECEIPT_PUBKEY]).ok, true);
  // The issuer's receipt under some other pin.
  assert.equal(verifyReceiptBinding(REAL_RECEIPT, [TEST_RECEIPT_PUBKEY]).ok, false);
  for (const pins of [[], ["not-a-key"], [RECEIPT_ISSUER_PUBKEY, ""], ["1111"]] as string[][]) {
    const r = verifyReceiptBinding(REAL_RECEIPT, pins);
    assert.equal(r.ok, false, JSON.stringify(pins));
    assert.match(r.ok ? "" : r.error, /pinned/);
  }
});

test("a changed signed field is refused: the leaf no longer matches, or the field is not well-formed", () => {
  for (const [name, change] of SIGNED_FIELD_CHANGES) {
    const r = verifyReceiptBinding(realReceiptWith(change));
    assert.equal(r.ok, false, name);
  }
  // The leaf rewritten to match the changed fields: now the signature is for another leaf.
  const rescored = signTestReceipt({ ...REAL_RECEIPT.preimage, score: 99 });
  const relabelled = { ...REAL_RECEIPT, leaf: rescored.leaf, preimage: rescored.preimage };
  assert.deepEqual(verifyReceiptBinding(relabelled), {
    ok: false, error: "receipt signature does not verify under the pinned receipt issuer key",
  });
  // A changed signature, a changed leaf.
  assert.equal(verifyReceiptBinding({ ...REAL_RECEIPT, signature: rescored.signature }).ok, false);
  assert.match(
    (verifyReceiptBinding({ ...REAL_RECEIPT, leaf: `0x${"ab".repeat(32)}` }) as { error: string }).error,
    /does not match the leaf recomputed/,
  );
});

test("a value that only encodes to the signed bytes is refused, not normalized", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["score + 65536 (same low 16 bits)", { score: 67 + 65536 }, /score must be an integer in 0\.\.65535/],
    ["score as a string", { score: "67" }, /score must be an integer/],
    ["score as a float", { score: 67.5 }, /score must be an integer/],
    ["score as a boolean", { score: true }, /score must be an integer/],
    ["score missing", { score: undefined }, /score is required/],
    ["confidence_bps as a string", { confidence_bps: "6500" }, /confidence_bps must be an integer/],
    ["confidence_bps over 10000", { confidence_bps: 10001 }, /confidence_bps must be an integer in 0\.\.10000/],
    ["timestamp_unix as a string", { timestamp_unix: "1794627727" }, /timestamp_unix must be an integer/],
    ["agent_id as a number", { agent_id: 7 }, /agent_id must be a string/],
    ["agent_id as an array of its text", { agent_id: [REAL_RECEIPT.preimage.agent_id] }, /agent_id must be a string/],
    ["agent_id with a lone surrogate", { agent_id: "a\ud800" }, /well-formed UTF-8/],
    ["agent_id too long", { agent_id: "a".repeat(257) }, /at most 256 bytes/],
    ["payer empty", { payer: "" }, /payer must be a non-empty string/],
    ["payer as an object", { payer: {} }, /payer must be a non-empty string/],
    ["reputation_data_quality as a number", { reputation_data_quality: 1 }, /reputation_data_quality must be a string/],
    ["reputation_score as a string", { reputation_score: "1" }, /reputation_score must be an integer/],
    ["settlement_tx as a number", { settlement_tx: 5 }, /settlement_tx must be a string/],
    ["settlement_anchor uppercase", { settlement_anchor: String(REAL_RECEIPT.preimage.settlement_anchor).toUpperCase() },
      /64 lowercase hex/],
    ["settlement_anchor not matching settlement_tx", { settlement_anchor: "11".repeat(32) },
      /settlement_anchor does not match preimage\.settlement_tx/],
    ["neither settlement field", { settlement_tx: null, settlement_anchor: null }, /no settlement_tx and no settlement_anchor/],
    ["staleness_days as a string", { staleness_days: "3" }, /staleness_days must be an integer/],
    ["score_decay_model with a non-ASCII char", { score_decay_model: "stép" }, /printable ASCII/],
    ["preimage version not v7", { version: "v6" }, /needs kind twzrd_reputation_receipt_v7 and version v7/],
    ["an attention domain", { domain: "TWZRD:AO_ATTENTION_RECEIPT_V6" }, /is not a signed reputation receipt/],
    ["an unknown domain", { domain: "TWZRD:AO_REPUTATION_RECEIPT_V7_V8" }, /is not a signed reputation receipt/],
    ["domain as an array", { domain: ["TWZRD:AO_REPUTATION_RECEIPT_V7"] }, /is not a signed reputation receipt/],
  ];
  for (const [name, change, want] of cases) {
    const r = verifyReceiptBinding(realReceiptWith(change));
    assert.equal(r.ok, false, name);
    assert.match(r.ok ? "" : r.error, want, name);
  }
  const top: Array<[string, unknown, RegExp]> = [
    ["no receipt", undefined, /not an object/],
    ["an array", [REAL_RECEIPT], /not an object/],
    ["a string", JSON.stringify(REAL_RECEIPT), /not an object/],
    ["no preimage", { ...REAL_RECEIPT, preimage: undefined }, /no preimage object/],
    ["preimage as an array", { ...REAL_RECEIPT, preimage: [REAL_RECEIPT.preimage] }, /no preimage object/],
    ["leaf as an array of the leaf", { ...REAL_RECEIPT, leaf: [REAL_RECEIPT.leaf] }, /leaf must be a string/],
    ["leaf as a number", { ...REAL_RECEIPT, leaf: 0 }, /leaf must be a string/],
    ["no leaf", { ...REAL_RECEIPT, leaf: undefined }, /leaf must be a string/],
    ["no signature", { ...REAL_RECEIPT, signature: undefined }, /signature must be a base58 64-byte/],
    ["signature not base58", { ...REAL_RECEIPT, signature: "0OIl" }, /signature must be a base58 64-byte/],
    ["signature of the wrong length", { ...REAL_RECEIPT, signature: "3mJr7AoUXx2Wqd" }, /signature must be a base58 64-byte/],
    ["kind removed", { ...REAL_RECEIPT, kind: undefined }, /needs kind twzrd_reputation_receipt_v7/],
    ["version removed", { ...REAL_RECEIPT, version: undefined }, /needs kind twzrd_reputation_receipt_v7/],
  ];
  for (const [name, receipt, want] of top) {
    const r = verifyReceiptBinding(receipt);
    assert.equal(r.ok, false, name);
    assert.match(r.ok ? "" : r.error, want, name);
  }
  // An uppercase or unprefixed spelling of the same leaf is the same leaf.
  assert.equal(verifyReceiptBinding({ ...REAL_RECEIPT, leaf: REAL_LEAF.toUpperCase() }).ok, true);
  assert.equal(verifyReceiptBinding({ ...REAL_RECEIPT, leaf: REAL_LEAF }).ok, true);
});

test("fields the leaf does not carry are outside the check", () => {
  // The key labels, a field the layout does not name, and settlement_tx before its last 32 bytes.
  const tx = String(REAL_RECEIPT.preimage.settlement_tx);
  const r = verifyReceiptBinding(realReceiptWith(
    { attention_score: 5, note: "added", settlement_tx: `XXXX${tx.slice(4)}` },
    { signing_pubkey: TEST_RECEIPT_PUBKEY, key_id: "other", signing_alg: "none" },
  ));
  assert.equal(r.ok, true);
  // On V6 the freshness fields are not in the leaf.
  const v6 = signTestReceipt({}, "v6");
  const later = { ...v6, preimage: { ...v6.preimage, recheck_after_unix: 1999999999, staleness_days: 365 } };
  assert.equal(verifyReceiptBinding(later, [TEST_RECEIPT_PUBKEY]).ok, true);
  // On V7 they are.
  const v7 = signTestReceipt();
  const v7later = { ...v7, preimage: { ...v7.preimage, staleness_days: 4, recheck_after_unix: 1790000000 + 4 * 86400 } };
  assert.equal(verifyReceiptBinding(v7later, [TEST_RECEIPT_PUBKEY]).ok, false);
});

test("Path A: the issued receipt with its own log proof is approved", async () => {
  const { result, verifier } = await pathA(REAL_RECEIPT);
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.logInclusionDenied, undefined);
  assert.deepEqual(result.logInclusion, {
    checked: true, receipt_bound: true, leaf: REAL_LEAF, valid: true, leaf_index: 19, tree_size: 20,
  });
  assert.equal(verifier.calls.length, 1);
  assert.equal(verifier.calls[0].ctx.leaf, REAL_LEAF, "the verifier is handed the leaf the gate bound");
  assert.deepEqual(result.receipt, REAL_RECEIPT);
});

test("Path A: a changed signed field beside the same valid log proof is denied, and the log is never asked", async () => {
  for (const [name, change] of SIGNED_FIELD_CHANGES) {
    const tampered = realReceiptWith(change);
    assert.equal(tampered.leaf, REAL_RECEIPT.leaf, "the leaf is the logged one");

    // What the log verifier alone says of this response: the leaf is in the log.
    const logOnly = verifyLogInclusion({ twzrd_receipt: tampered, log_inclusion: REAL_LOG_INCLUSION }, DEFAULT_STH_PUBKEY);
    assert.equal(logOnly.valid, true, `${name}: the proof itself still verifies`);

    const { result, verifier } = await pathA(tampered);
    assert.equal(result.approved, false, `${name}: approved (${result.reason})`);
    assert.equal(result.logInclusionDenied, true, name);
    assert.equal(result.policyAction, "block", name);
    assert.match(result.reason, INVALID, name);
    assert.equal(result.logInclusion?.denyReason, "twzrd_log_inclusion_receipt_invalid", name);
    assert.equal(result.logInclusion?.receipt_bound, false, name);
    assert.equal(result.logInclusion?.checked, false, name);
    assert.equal(result.logInclusion?.valid, false, name);
    assert.equal(verifier.calls.length, 0, `${name}: the verifier ran`);
    assert.deepEqual(result.receipt, tampered, "the paid receipt is still handed back");
  }
});

test("Path A: the refusal is the same on every run and names what failed", async () => {
  const reasons = new Set<string>();
  for (let i = 0; i < 3; i++) reasons.add((await pathA(realReceiptWith({ score: 99 }))).result.reason);
  assert.equal(reasons.size, 1);
  assert.match([...reasons][0], /^twzrd_log_inclusion_receipt_invalid \(receipt\.leaf does not match the leaf recomputed from the receipt's fields; price=/);
});

test("Path A: a receipt signed by another key is denied under the default pin and accepted under its own", async () => {
  const mine = signTestReceipt();
  const block = { ...REAL_LOG_INCLUSION, leaf: mine.leaf };
  const denied = await pathA(mine, {}, block);
  assert.equal(denied.result.approved, false);
  assert.match(denied.result.reason, /^twzrd_log_inclusion_receipt_invalid \(receipt signature does not verify/);
  assert.equal(denied.verifier.calls.length, 0);

  // Under the host's own pin the receipt binds; the proof is for another leaf, so the log check denies.
  const bound = await pathA(mine, { receiptPubkey: TEST_RECEIPT_PUBKEY }, block);
  assert.equal(bound.verifier.calls.length, 1);
  assert.equal(bound.result.logInclusion?.receipt_bound, true);
  assert.match(bound.result.reason, /^twzrd_log_inclusion_failed \(/);
});

test("a tolerated pending leaf or an accepted TOFU verdict does not excuse an unbound receipt", async () => {
  const pending: LogInclusionVerdict = { valid: false, errors: ["HTTP 404"], not_yet_merged: true };
  const tofu: LogInclusionVerdict = { valid: true, errors: [], tofu: true };
  for (const [verdict, extras] of [
    [pending, { onPending: "allow" }],
    [tofu, { refuseTofu: false }],
  ] as Array<[LogInclusionVerdict, Record<string, unknown>]>) {
    let ran = 0;
    const policy = resolveRequireLogInclusionPolicy({ verifier: async () => { ran += 1; return verdict; }, ...extras })!;
    const tampered = await evaluateLogInclusion(realReceiptWith({ score: 99 }), policy, { response: {} });
    assert.equal(tampered.denyReason, "twzrd_log_inclusion_receipt_invalid");
    assert.equal(ran, 0);
    const genuine = await evaluateLogInclusion(REAL_RECEIPT, policy, { response: {} });
    assert.equal(genuine.denyReason, undefined, "the same policy lets the issued receipt through");
    assert.equal(ran, 1);
  }
});

test("a verdict that names another leaf is refused; one that names the receipt's leaf, in any spelling, is not", async () => {
  const run = (leaf: unknown) => evaluateLogInclusion(
    REAL_RECEIPT,
    resolveRequireLogInclusionPolicy({ verifier: async () => ({ valid: true, errors: [], leaf }) as never })!,
    { response: {} },
  );
  for (const leaf of ["ab".repeat(32), `0x${"ab".repeat(32)}`, [REAL_LEAF], 7, "", {}]) {
    const o = await run(leaf);
    assert.equal(o.valid, false, JSON.stringify(leaf));
    assert.equal(o.denyReason, "twzrd_log_inclusion_failed", JSON.stringify(leaf));
    assert.deepEqual(o.errors, ["the verifier's verdict names a different leaf than the receipt's"]);
  }
  for (const leaf of [REAL_LEAF, `0x${REAL_LEAF}`, REAL_LEAF.toUpperCase(), undefined, null]) {
    const o = await run(leaf);
    assert.equal(o.valid, true, JSON.stringify(leaf));
    assert.equal(o.denyReason, undefined);
    assert.equal(o.leaf, REAL_LEAF);
  }
});

test("receiptPubkey: a host pin replaces the default, and a pin that is not a key verifies nothing", async () => {
  const v = async () => ({ valid: true, errors: [] });
  assert.deepEqual(resolveRequireLogInclusionPolicy({ verifier: v }), {
    verifier: v, hard: true, onPending: "deny", refuseTofu: true,
  });
  assert.deepEqual(resolveRequireLogInclusionPolicy({ verifier: v, receiptPubkey: TEST_RECEIPT_PUBKEY })?.receiptPubkeys,
    [TEST_RECEIPT_PUBKEY]);
  assert.deepEqual(
    resolveRequireLogInclusionPolicy({ verifier: v, receiptPubkey: [RECEIPT_ISSUER_PUBKEY, TEST_RECEIPT_PUBKEY] })
      ?.receiptPubkeys,
    [RECEIPT_ISSUER_PUBKEY, TEST_RECEIPT_PUBKEY],
  );
  for (const bad of [null, 5, "", [], [RECEIPT_ISSUER_PUBKEY, 5], {}, true] as unknown[]) {
    const policy = resolveRequireLogInclusionPolicy({ verifier: v, receiptPubkey: bad })!;
    assert.deepEqual(policy.receiptPubkeys, [], JSON.stringify(bad));
    const o = await evaluateLogInclusion(REAL_RECEIPT, policy, { response: {} });
    assert.equal(o.denyReason, "twzrd_log_inclusion_receipt_invalid", JSON.stringify(bad));
    assert.deepEqual(o.errors, ["no receipt issuer key is pinned"]);
  }
  // A pin that is a string but not a key reaches the check and is refused there.
  const notKey = resolveRequireLogInclusionPolicy({ verifier: v, receiptPubkey: "not-a-key" })!;
  assert.equal((await evaluateLogInclusion(REAL_RECEIPT, notKey, { response: {} })).denyReason,
    "twzrd_log_inclusion_receipt_invalid");
});

test("a soft policy reports the unbound receipt and does not deny", async () => {
  const { result, verifier } = await pathA(realReceiptWith({ score: 99 }), { hard: false });
  assert.equal(result.approved, true);
  assert.equal(result.logInclusionDenied, undefined);
  assert.equal(result.logInclusion?.receipt_bound, false);
  assert.equal(result.logInclusion?.valid, false);
  assert.equal(result.logInclusion?.denyReason, undefined);
  assert.equal(verifier.calls.length, 0);
});
