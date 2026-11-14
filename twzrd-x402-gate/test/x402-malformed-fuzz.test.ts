/**
 * Parser-resilience fuzz: malformed x402 inputs through the gate's real parse points.
 *
 * Fixtures: test/fixtures/x402-malformed-fuzz.json (26 entries; no keys, no
 * network; `<tx>` is a placeholder). Every entry is one of the file's
 * well-formed baselines with exactly one malformation, which the entry
 * declares: `replace` (a text that occurs once in the baseline, and what stands
 * in its place), `truncate_to` (a prefix of the baseline) or, for a header,
 * `encoding` (the unmodified baseline in another base64 dialect). The first
 * test below rebuilds every entry from its baseline and its malformation and
 * compares the result with the bytes the entry carries, so a label cannot say
 * one thing while the bytes are another. The receipt baseline is the
 * repository's V7 example receipt.
 *
 * What is asserted, for every entry:
 *
 *   1. it ends in a structured refusal: a refusal code, `approved: false`, a
 *      settle-guard abort, or an Error the gate authored ("[twzrd] payment
 *      blocked: ..."), never an approval;
 *   2. the refusal is the one the entry's `expected_outcome` names;
 *   3. no raw SyntaxError / TypeError / RangeError escapes a gate function;
 *   4. no promise rejection goes unhandled (checked once, last).
 *
 * What the outcomes mean. A header in another base64 dialect (URL-safe
 * alphabet, padding missing or doubled) is refused for its encoding: the gate
 * decodes canonical RFC 4648 standard base64 only, so it reads no payment out
 * of a value Node's own decoder would read the baseline out of. And the receipt
 * path checks the receipt itself before it asks the log: it recomputes the leaf
 * from the receipt's preimage, requires `leaf` to equal it, and requires the
 * issuer's signature over it under the pinned key. Every receipt entry sits
 * beside a log proof that verifies for the baseline's leaf, and the unmodified
 * baseline beside that proof is approved, so an entry that changes a score, a
 * timestamp or the signature is denied for that change and nothing else.
 *
 * Entry points, by fixture target:
 *   header  (X-PAYMENT / PAYMENT-SIGNATURE value)
 *     - paymentBindingRefusal(): the outgoing payment against what the buyer approved
 *     - wrapFetchWithTwzrdGate(): the same bytes as a 402 PAYMENT-REQUIRED header
 *   verify_body / settle_body (raw facilitator request body)
 *     - wrapFetchWithTwzrdGate(): the raw body, base64'd, as a PAYMENT-REQUIRED header
 *     - when the body parses: evaluate_x402_resource() on its paymentRequirements
 *       under an allow card, then paymentBindingRefusal() on its paymentPayload
 *     - when the body parses: createTwzrdSettleGuard() (fail-closed) on it,
 *       which must abort: no fixture carries a transaction a payer can be read
 *       from, so there is nobody to screen
 *   receipt (raw paid /trust receipt)
 *     - evaluate_x402_resource() Path A with requireLogInclusion wired to the
 *       real offline verifier, the same wiring as log-inclusion-offline.test.ts,
 *       and a proof for the baseline's leaf from a test log whose key the
 *       verifier is pinned to; the receipt bytes are spliced into the paid
 *       response unparsed, so truncated JSON reaches the gate as bytes.
 *
 * Each entry point also has one well-formed control that must be approved, and
 * the header and facilitator baselines pass the checks their entries fail.
 *
 * Run: npx tsx --test test/x402-malformed-fuzz.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveConfig } from "../src/config.js";
import { evaluate_x402_resource } from "../src/evaluate.js";
import {
  approvedRequirementOf,
  PAYMENT_DIFFERS_FROM_APPROVAL,
  PAYMENT_PAYLOAD_UNREADABLE,
  paymentBindingRefusal,
} from "../src/payment-binding.js";
import { verifyReceiptBinding } from "../src/receipt-binding.js";
import { createTwzrdSettleGuard, type SettleGuardContext } from "../src/seller-hook.js";
import { decodeBase64Strict } from "../src/strict-base64.js";
import type { X402PaymentRequirements } from "../src/types.js";
import { wrapFetchWithTwzrdGate } from "../src/wrap-fetch.js";
import { verifyLogInclusion } from "../../twzrd-log-verifier/src/client.js";
import { DEFAULT_STH_PUBKEY } from "../../twzrd-log-verifier/src/index.js";
import {
  REAL_LEAF,
  REAL_LOG_INCLUSION,
  REAL_RECEIPT,
  TEST_LOG_PUBKEY,
  testLogProofFor,
} from "./helpers/receipts.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** How a header value is made from its text. Only `base64` is what x402 specifies. */
const ENCODERS = {
  base64: b64,
  base64_padding_removed: (s: string) => b64(s).replace(/=+$/, ""),
  base64_extra_padding: (s: string) => `${b64(s)}=`,
  base64url: (s: string) => b64(s).replace(/\+/g, "-").replace(/\//g, "_"),
  base64url_padding_removed: (s: string) => Buffer.from(s, "utf8").toString("base64url"),
} as const;
type Encoding = keyof typeof ENCODERS;

/** The one thing an entry changes about its baseline. */
type Malformation =
  | { replace: { find: string; with: string } }
  | { truncate_to: number }
  | { encoding: Exclude<Encoding, "base64"> };

type FuzzHeader = { name: string; value: string; plaintext: string; encoding: Encoding };
type Fixture = {
  id: string;
  category: string;
  description: string;
  target: "header" | "verify_body" | "settle_body" | "receipt";
  baseline: string;
  malformation: Malformation;
  /** Whether the malformed text is still JSON. */
  parses: boolean;
  headers: FuzzHeader[];
  raw_body: string | null;
  expected_outcome: string;
};

const FILE = JSON.parse(
  readFileSync(new URL("./fixtures/x402-malformed-fuzz.json", import.meta.url), "utf8"),
) as { fixtureCount: number; baselines: Record<string, string>; fixtures: Fixture[] };
const FIXTURES = FILE.fixtures;

/** The text an entry's baseline becomes under the malformation the entry declares, and how a header encodes it. */
function derive(f: Fixture): { text: string; encoding: Encoding } {
  const base = FILE.baselines[f.baseline];
  assert.equal(typeof base, "string", `${f.id}: no baseline named ${f.baseline}`);
  const m = f.malformation;
  assert.equal(Object.keys(m).length, 1, `${f.id}: one malformation, not ${Object.keys(m).join(" + ")}`);
  if ("replace" in m) {
    assert.ok(m.replace.find.length > 0 && m.replace.find !== m.replace.with, `${f.id}: replace changes nothing`);
    const parts = base.split(m.replace.find);
    assert.equal(parts.length, 2, `${f.id}: find occurs ${parts.length - 1} times in ${f.baseline}, not once`);
    return { text: parts.join(m.replace.with), encoding: "base64" };
  }
  if ("truncate_to" in m) {
    assert.ok(
      Number.isInteger(m.truncate_to) && m.truncate_to > 0 && m.truncate_to < base.length,
      `${f.id}: truncate_to ${m.truncate_to} is not a proper prefix of ${f.baseline}`,
    );
    return { text: base.slice(0, m.truncate_to), encoding: "base64" };
  }
  // The file is data: check the name it gives before using it as a key.
  const named: string = m.encoding;
  assert.ok(named !== "base64" && Object.hasOwn(ENCODERS, named), `${f.id}: encoding ${named} is not a dialect`);
  return { text: base, encoding: m.encoding };
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const PAYMENT_HEADER_NAMES = new Set(["x-payment", "payment-signature"]);
const byTarget = (...targets: Fixture["target"][]) => FIXTURES.filter((f) => targets.includes(f.target));

// Promise rejections nobody handled, collected for the last test.
const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason);
});

// ---------------------------------------------------------------------------
// What the buyer approved. No fixture pays this seller.
const SELLER = "SeLLeRWa11et1111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const RESOURCE = "https://seller.example/paid";
const APPROVED_REQ = {
  scheme: "exact",
  network: SOLANA_MAINNET,
  amount: "1000",
  asset: USDC,
  payTo: SELLER,
  maxTimeoutSeconds: 60,
  resource: RESOURCE,
};
const APPROVED = approvedRequirementOf(APPROVED_REQ);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const preflight = (card: Record<string, unknown>): typeof fetch =>
  (async () => json({ readiness_card: card, wash_flagged: false, confidence: "full" })) as unknown as typeof fetch;

const ALLOW = { decision: "allow", trust_score: 90, can_spend: true, recommended_cap_usdc: 1000 };
const WARN = { decision: "warn", trust_score: 45, can_spend: false, recommended_cap_usdc: 1000 };

/** Errors a parser or a property access throws by itself, as opposed to a refusal the gate wrote. */
function isRawJsError(e: unknown): boolean {
  return e instanceof SyntaxError || e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError;
}

function assertGateRefusalError(e: unknown, where: string): void {
  assert.ok(e instanceof Error, `${where}: threw a non-Error: ${String(e)}`);
  assert.ok(!isRawJsError(e), `${where}: raw ${(e as Error).name} escaped: ${(e as Error).message}`);
  assert.match((e as Error).message, /^\[twzrd\] payment blocked: /, `${where}: not a gate refusal`);
}

/** Run the 402 fetch gate over a response carrying `paymentRequired` as its PAYMENT-REQUIRED header. */
async function gate402Header(paymentRequired: string): Promise<{ passed: Response } | { error: unknown }> {
  const merchant = (async () =>
    new Response("", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequired } })) as unknown as typeof fetch;
  const gated = wrapFetchWithTwzrdGate(merchant, resolveConfig({ fetch: preflight(ALLOW) }));
  try {
    return { passed: await gated(RESOURCE) };
  } catch (error) {
    return { error };
  }
}

/** The input reaches the gate only if fetch's Headers accepts it as a header value. */
function headerRepresentable(name: string, value: string): boolean {
  try {
    new Headers([[name, value]]);
    return true;
  } catch {
    return false;
  }
}

function parseOrUndefined(raw: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// The receipt baseline (the repository's V7 example receipt, signed by the
// receipt issuer key) and a log proof that verifies for its leaf: a test log
// the offline verifier is pinned to. Every receipt entry is checked beside it.
const BASELINE_RECEIPT = JSON.parse(FILE.baselines.v7_receipt) as { leaf: string };
const BASELINE_BLOCK = testLogProofFor(BASELINE_RECEIPT.leaf);
const RECEIPT_REQS = {
  payTo: SELLER,
  maxAmountRequired: "50000",
  resource: RESOURCE,
  network: "solana",
} as X402PaymentRequirements;

/**
 * Path A with the receipt bytes spliced into the paid /trust response, unparsed, beside `block`.
 * `logKey` is the log key the offline verifier is pinned to.
 */
function evaluateWithReceiptBytes(receiptRaw: string, block: unknown = BASELINE_BLOCK, logKey = TEST_LOG_PUBKEY) {
  const body = `{"tx":"TX_FUZZ","twzrd_receipt":${receiptRaw},"log_inclusion":${JSON.stringify(block)}}`;
  let verifierCalls = 0;
  return evaluate_x402_resource(RESOURCE, RECEIPT_REQS, {
    fetch: preflight(WARN),
    autoReceipt: true,
    x402Fetch: (async () => json(body)) as unknown as typeof fetch,
    requireLogInclusion: {
      verifier: async (_receipt: unknown, ctx: { response: unknown }) => {
        verifierCalls += 1;
        return verifyLogInclusion(ctx.response, logKey);
      },
    },
  }).then((r) => Object.assign(r, { verifierCalls }));
}

// ---------------------------------------------------------------------------
test("fixture file: 26 entries, every target has a harness", () => {
  assert.equal(FIXTURES.length, 26);
  assert.equal(FILE.fixtureCount, FIXTURES.length);
  for (const f of FIXTURES) {
    assert.ok(["header", "verify_body", "settle_body", "receipt"].includes(f.target), `${f.id}: target ${f.target}`);
    if (f.target === "header") {
      assert.ok(f.headers.some((h) => PAYMENT_HEADER_NAMES.has(h.name.toLowerCase())), `${f.id}: no payment header`);
    } else {
      assert.equal(typeof f.raw_body, "string", `${f.id}: no raw_body`);
    }
  }
  assert.equal(new Set(FIXTURES.map((f) => f.id)).size, FIXTURES.length, "ids are unique");
  // The tests below are generated per target: a target with no entries would
  // drop its tests without a failure anywhere.
  assert.deepEqual(
    {
      header: byTarget("header").length,
      verify_body: byTarget("verify_body").length,
      settle_body: byTarget("settle_body").length,
      receipt: byTarget("receipt").length,
    },
    { header: 9, verify_body: 3, settle_body: 3, receipt: 11 },
  );
});

test("every entry is its baseline with the one malformation it declares", () => {
  const carriedBy = new Map<string, string>();
  for (const f of FIXTURES) {
    const { text, encoding } = derive(f);
    assert.equal(f.parses, isJson(text), `${f.id}: parses`);
    let wire: string;
    if (f.target === "header") {
      assert.equal(f.headers.length, 1, `${f.id}: one header`);
      const h = f.headers[0];
      assert.equal(h.plaintext, text, `${f.id}: plaintext is not the baseline with the declared malformation`);
      assert.equal(h.encoding, encoding, `${f.id}: encoding`);
      assert.equal(h.value, ENCODERS[encoding](text), `${f.id}: value is not ${encoding} of the plaintext`);
      if (encoding !== "base64") {
        // The dialect has to show in the bytes: URL-safe and standard base64 are
        // the same text unless the input produces a '+' or a '/'.
        assert.notEqual(h.value, b64(text), `${f.id}: ${encoding} is byte-identical to standard base64 here`);
        // What the description says of it: Node's own decoder reads the baseline
        // back out of the value, and the decoder the gate uses reads nothing.
        assert.equal(Buffer.from(h.value, "base64").toString("utf8"), text, `${f.id}: Node decodes it differently`);
        assert.equal(decodeBase64Strict(h.value), null, `${f.id}: the gate's decoder accepts it`);
      } else {
        assert.equal(decodeBase64Strict(h.value)?.toString("utf8"), text, `${f.id}: standard base64 the gate does not read`);
      }
      assert.equal(f.raw_body, null, `${f.id}: a header entry carries no body`);
      wire = h.value;
    } else {
      assert.deepEqual(f.headers, [], `${f.id}: a body entry carries no header`);
      assert.equal(f.raw_body, text, `${f.id}: raw_body is not the baseline with the declared malformation`);
      wire = text;
    }
    assert.equal(carriedBy.get(wire), undefined, `${f.id} carries the same bytes as ${carriedBy.get(wire)}`);
    carriedBy.set(wire, f.id);
  }
});

const V7_EXAMPLE = new URL("../../eliza-plugin-source/test/fixtures/receipt-v7.example.json", import.meta.url);

test(
  "the receipt baseline is the repository's V7 example receipt",
  { skip: existsSync(V7_EXAMPLE) ? false : "eliza-plugin-source is not in this checkout" },
  () => {
    assert.deepEqual(JSON.parse(FILE.baselines.v7_receipt), JSON.parse(readFileSync(V7_EXAMPLE, "utf8")));
  },
);

test("baselines are well-formed: a baseline payment matches its own requirement", async () => {
  for (const [name, text] of Object.entries(FILE.baselines)) {
    assert.ok(isJson(text), `${name} is not JSON`);
  }
  // Payment headers. The fixture tests compare against an approval no entry
  // pays; here each baseline is compared with the requirement it names itself.
  const ownRequirement = (name: string) => {
    const p = JSON.parse(FILE.baselines[name]) as Record<string, unknown>;
    return approvedRequirementOf(p.accepted ?? { scheme: p.scheme, network: p.network });
  };
  for (const name of ["x402_v1_payment", "x402_v2_payment"]) {
    assert.equal(paymentBindingRefusal(ownRequirement(name), b64(FILE.baselines[name])), undefined, name);
  }
  // A base64 dialect is a refusal by itself: against the requirement the
  // baseline names, where the standard encoding of the same payment passes,
  // each of these is unreadable.
  const dialects = byTarget("header").filter((f) => "encoding" in f.malformation);
  assert.equal(dialects.length, 4);
  for (const f of dialects) {
    assert.equal(
      paymentBindingRefusal(ownRequirement(f.baseline), f.headers[0].value),
      PAYMENT_PAYLOAD_UNREADABLE,
      f.id,
    );
    assert.equal(paymentBindingRefusal(ownRequirement(f.baseline), b64(f.headers[0].plaintext)), undefined, f.id);
  }
  // The facilitator request: its requirement is approved and its payload pays it.
  const fac = JSON.parse(FILE.baselines.facilitator_request) as Record<string, unknown>;
  const reqs = fac.paymentRequirements as X402PaymentRequirements;
  const r = await evaluate_x402_resource(RESOURCE, reqs, { fetch: preflight(ALLOW) });
  assert.equal(r.approved, true, r.reason);
  assert.equal(paymentBindingRefusal(approvedRequirementOf(reqs), b64(JSON.stringify(fac.paymentPayload))), undefined);
});

// Controls: each harness can say yes.
test("control: the approved payment itself passes payment binding", () => {
  const header = b64(JSON.stringify({ x402Version: 2, accepted: APPROVED_REQ, payload: { transaction: "AQ==" } }));
  assert.equal(paymentBindingRefusal(APPROVED, header), undefined);
});

test("control: a well-formed PAYMENT-REQUIRED challenge passes the 402 gate under allow", async () => {
  const out = await gate402Header(b64(JSON.stringify({ x402Version: 2, accepts: [APPROVED_REQ] })));
  assert.ok("passed" in out, `refused: ${"error" in out ? String((out.error as Error)?.message) : ""}`);
  assert.equal(out.passed.status, 402, "approved 402 is handed back for payment");
});

test("control: a well-formed requirement is approved by evaluate_x402_resource under allow", async () => {
  const r = await evaluate_x402_resource(RESOURCE, APPROVED_REQ as unknown as X402PaymentRequirements, {
    fetch: preflight(ALLOW),
  });
  assert.equal(r.approved, true, r.reason);
});

test("control: an issued receipt with the proof the log served for it is approved through Path A", async () => {
  const r = await evaluateWithReceiptBytes(JSON.stringify(REAL_RECEIPT), REAL_LOG_INCLUSION, DEFAULT_STH_PUBKEY);
  assert.equal(r.approved, true, r.reason);
  assert.equal(r.logInclusion?.receipt_bound, true);
  assert.equal(r.logInclusion?.valid, true);
  assert.equal(r.logInclusion?.leaf, REAL_LEAF);
});

// The control the receipt entries are read against: the baseline they are all
// made from, beside the proof they all sit beside, is approved. What an entry
// changes is then the only thing that can deny it.
test("control: the receipt baseline with the test log's proof for its leaf is approved through Path A", async () => {
  assert.equal(verifyReceiptBinding(BASELINE_RECEIPT).ok, true, "the baseline is signed by the issuer key");
  const r = await evaluateWithReceiptBytes(FILE.baselines.v7_receipt);
  assert.equal(r.approved, true, r.reason);
  assert.equal(r.logInclusion?.receipt_bound, true);
  assert.equal(r.logInclusion?.valid, true);
  assert.equal(r.logInclusion?.leaf_index, 5);
  assert.equal(r.logInclusion?.tree_size, 12);
  assert.equal(r.verifierCalls, 1);
  // The proof is not one the production log key signed.
  const underProdPin = await evaluateWithReceiptBytes(FILE.baselines.v7_receipt, BASELINE_BLOCK, DEFAULT_STH_PUBKEY);
  assert.equal(underProdPin.approved, false);
  assert.match(underProdPin.reason, /^twzrd_log_inclusion_failed \(/);
});

// ---------------------------------------------------------------------------
// Payment headers.
for (const f of byTarget("header")) {
  for (const h of f.headers.filter((x) => PAYMENT_HEADER_NAMES.has(x.name.toLowerCase()))) {
    test(`header ${f.id} (${h.name}): payment binding refuses, no throw`, () => {
      let refusal: string | undefined;
      assert.doesNotThrow(() => {
        refusal = paymentBindingRefusal(APPROVED, h.value);
      }, `${f.id}: paymentBindingRefusal threw`);
      assert.ok(
        refusal === PAYMENT_PAYLOAD_UNREADABLE || refusal === PAYMENT_DIFFERS_FROM_APPROVAL,
        `${f.id}: expected a refusal code, got ${String(refusal)}`,
      );
      assert.equal(refusal, f.expected_outcome, `${f.id}: expected_outcome`);
    });

    test(`header ${f.id} (${h.name}): as a 402 PAYMENT-REQUIRED header, the gate refuses`, async () => {
      if (!headerRepresentable("PAYMENT-REQUIRED", h.value)) {
        // fetch rejects the value before any gate code runs; nothing to gate.
        assert.throws(() => new Headers([["PAYMENT-REQUIRED", h.value]]), TypeError);
        return;
      }
      const out = await gate402Header(h.value);
      assert.ok("error" in out, `${f.id}: the 402 was handed back for payment`);
      assertGateRefusalError(out.error, f.id);
    });
  }
}

// ---------------------------------------------------------------------------
// Facilitator verify / settle bodies.
for (const f of byTarget("verify_body", "settle_body")) {
  const raw = f.raw_body as string;
  const body = parseOrUndefined(raw);

  test(`body ${f.id}: raw body as a 402 PAYMENT-REQUIRED header, the gate refuses`, async () => {
    const out = await gate402Header(b64(raw));
    assert.ok("error" in out, `${f.id}: the 402 was handed back for payment`);
    assertGateRefusalError(out.error, f.id);
  });

  if (!body) {
    test(`body ${f.id}: does not parse, so no gate function receives it as an object`, () => {
      assert.equal(f.expected_outcome, "not_json");
      assert.throws(() => JSON.parse(raw), SyntaxError);
    });
    continue;
  }

  test(`body ${f.id}: its requirement is refused pre-sign or its payload fails binding`, async () => {
    const reqs = body.paymentRequirements as X402PaymentRequirements;
    const r = await evaluate_x402_resource(RESOURCE, reqs, { fetch: preflight(ALLOW) });
    assert.equal(typeof r.approved, "boolean");
    if (!r.approved) {
      assert.equal(typeof r.reason, "string");
      assert.equal(f.expected_outcome, "requirement_refused", `${f.id}: refused pre-sign (${r.reason})`);
      return;
    }
    const payload = JSON.stringify(body.paymentPayload ?? null);
    let refusal: string | undefined;
    assert.doesNotThrow(() => {
      refusal = paymentBindingRefusal(approvedRequirementOf(reqs), b64(payload));
    });
    assert.ok(
      refusal !== undefined,
      `${f.id}: evaluate approved (${r.reason}) and the payload matches that approval`,
    );
    assert.equal(f.expected_outcome, "payload_differs_from_requirement", `${f.id}: approved, then ${refusal}`);
  });

  test(`body ${f.id}: fail-closed settle guard aborts, never throws`, async () => {
    // The screen itself would allow. The abort has to come from the guard
    // finding no payer to screen in the fixture's placeholder transaction.
    const guard = createTwzrdSettleGuard({
      screen: () => ({ decision: "allow", washFlagged: false }),
      failOpen: false,
      timeoutMs: 2000,
    });
    const ctx: SettleGuardContext = {
      paymentPayload: body.paymentPayload as SettleGuardContext["paymentPayload"],
      requirements: body.paymentRequirements,
    };
    const result = await guard(ctx);
    assert.ok(result, `${f.id}: the settle guard let the settlement continue`);
    assert.equal(result.abort, true);
    assert.match(result.reason, /^twzrd_/);
  });
}

// ---------------------------------------------------------------------------
// Receipts. Every paid response below carries a log proof that verifies for
// the baseline's leaf (the control above), so the log has nothing to object
// to. The gate checks the receipt first: preimage, field types and ranges,
// leaf, signature. `expected_outcome` says which of those an entry fails:
//   no_receipt_captured              the paid response is not JSON (the cut-off receipt)
//   receipt_no_preimage              the preimage is not an object
//   receipt_freshness_inconsistent   recheck_after_unix is not timestamp_unix + staleness_days * 86400
//   receipt_field_out_of_range       a signed integer field is outside what the leaf can encode
//   receipt_settlement_inconsistent  settlement_anchor is not the anchor of settlement_tx
//   receipt_leaf_mismatch            the fields no longer hash to the leaf the receipt names
//   receipt_leaf_not_a_string        the leaf is not a string (the array)
//   receipt_signature_unreadable     the signature is absent or not base58 for 64 bytes
const INVALID = "^twzrd_log_inclusion_receipt_invalid \\(";
const RECEIPT_DENIALS: Record<string, RegExp> = {
  no_receipt_captured: /^twzrd_log_inclusion_failed \(no receipt captured: /,
  receipt_no_preimage: new RegExp(`${INVALID}receipt has no preimage object`),
  receipt_freshness_inconsistent: new RegExp(
    `${INVALID}preimage\\.recheck_after_unix must equal timestamp_unix \\+ staleness_days \\* 86400`,
  ),
  receipt_field_out_of_range: new RegExp(`${INVALID}preimage\\.[a-z_]+ must be an integer in \\d+\\.\\.\\d+`),
  receipt_settlement_inconsistent: new RegExp(
    `${INVALID}preimage\\.settlement_anchor does not match preimage\\.settlement_tx`,
  ),
  receipt_leaf_mismatch: new RegExp(`${INVALID}receipt\\.leaf does not match the leaf recomputed from the receipt's fields`),
  receipt_leaf_not_a_string: new RegExp(`${INVALID}receipt\\.leaf must be a string of 64 hex chars`),
  receipt_signature_unreadable: new RegExp(`${INVALID}receipt\\.signature must be a base58 64-byte Ed25519 signature`),
};

test("every receipt outcome is one the harness knows, and every one it knows is used", () => {
  const used = new Set(byTarget("receipt").map((f) => f.expected_outcome));
  assert.deepEqual([...used].sort(), Object.keys(RECEIPT_DENIALS).sort());
});

for (const f of byTarget("receipt")) {
  test(`receipt ${f.id}: Path A with offline log inclusion denies, no throw`, async () => {
    const r = await evaluateWithReceiptBytes(f.raw_body as string);
    assert.equal(r.approved, false, `${f.id}: approved (${r.reason})`);
    assert.equal(r.logInclusionDenied, true, `${f.id}: denied for another reason: ${r.reason}`);
    assert.match(r.reason, /^twzrd_log_inclusion_(failed|error|pending|tofu_refused|receipt_invalid)/);
    const expected = RECEIPT_DENIALS[f.expected_outcome];
    assert.ok(expected, `${f.id}: unknown expected_outcome ${f.expected_outcome}`);
    assert.match(r.reason, expected, `${f.id}: expected_outcome`);
    // Denied before the log was asked: the proof beside it verifies, and would have passed.
    assert.equal(r.verifierCalls, 0, `${f.id}: the log verifier ran`);
    if (f.parses) {
      // What the log verifier alone says of the same paid response.
      const logOnly = verifyLogInclusion(
        { twzrd_receipt: JSON.parse(f.raw_body as string), log_inclusion: BASELINE_BLOCK },
        TEST_LOG_PUBKEY,
      );
      assert.equal(
        logOnly.valid,
        f.expected_outcome !== "receipt_leaf_not_a_string",
        `${f.id}: the log proof alone ${logOnly.valid ? "passes" : "fails"} (${logOnly.errors.join("; ")})`,
      );
    }
  });
}

// A leaf that is not a string is not converted to one. `String([leaf])` prints
// the leaf, so a conversion would read these receipts as naming the proven
// leaf. The gate refuses them before the log is asked, and the log verifier
// refuses them by itself.
test("a receipt whose leaf is an array holding the proven leaf is denied", async () => {
  for (const leaf of [[REAL_RECEIPT.leaf], [[REAL_RECEIPT.leaf]], [REAL_LEAF.toUpperCase()]]) {
    const receipt = { ...REAL_RECEIPT, leaf };
    const r = await evaluateWithReceiptBytes(JSON.stringify(receipt), REAL_LOG_INCLUSION, DEFAULT_STH_PUBKEY);
    assert.equal(r.approved, false, `approved (${r.reason}) with leaf ${JSON.stringify(leaf)}`);
    assert.equal(r.logInclusionDenied, true);
    assert.match(r.reason, RECEIPT_DENIALS.receipt_leaf_not_a_string);
    assert.equal(r.verifierCalls, 0);
    const logOnly = verifyLogInclusion({ twzrd_receipt: receipt, log_inclusion: REAL_LOG_INCLUSION }, DEFAULT_STH_PUBKEY);
    assert.equal(logOnly.valid, false);
    assert.deepEqual(logOnly.errors, ["twzrd_receipt.leaf: leaf must be a string of 64 hex chars"]);
  }
});

test("a proof whose leaf is an array holding the receipt's leaf is denied", async () => {
  const r = await evaluateWithReceiptBytes(
    JSON.stringify(REAL_RECEIPT),
    { ...REAL_LOG_INCLUSION, leaf: [REAL_RECEIPT.leaf] },
    DEFAULT_STH_PUBKEY,
  );
  assert.equal(r.approved, false, `approved (${r.reason})`);
  assert.equal(r.logInclusionDenied, true);
  assert.equal(r.logInclusion?.receipt_bound, true, "the receipt itself is genuine; the proof is what fails");
  assert.match((r.logInclusion?.errors ?? []).join(" "), /log_inclusion\.leaf: leaf must be a string/);
});

// Same rule for the proof's path: an entry is a hex string. An array holding
// the hash prints as that hash, so a verifier that converts entries accepts it.
test("a proof whose audit_path entry is an array holding the hash is denied", async () => {
  const path = BASELINE_BLOCK.audit_path as string[];
  assert.ok(path.length >= 2);
  for (const wrap of [(h: string) => [h], (h: string) => [[h]], () => 0, () => false, () => null]) {
    const audit_path = path.map((h, i) => (i === 1 ? wrap(h) : h));
    const r = await evaluateWithReceiptBytes(FILE.baselines.v7_receipt, { ...BASELINE_BLOCK, audit_path });
    assert.equal(r.approved, false, `approved (${r.reason}) with entry ${JSON.stringify(audit_path[1])}`);
    assert.equal(r.logInclusionDenied, true);
    assert.equal(r.logInclusion?.receipt_bound, true, "the receipt itself is genuine; the proof is what fails");
    assert.deepEqual(r.logInclusion?.errors, ["audit path: audit_path[1] must be a hex string"]);
  }
});

test("a receipt with no leaf beside a valid proof is denied", async () => {
  const { leaf: _leaf, ...noLeaf } = REAL_RECEIPT;
  const r = await evaluateWithReceiptBytes(JSON.stringify(noLeaf), REAL_LOG_INCLUSION, DEFAULT_STH_PUBKEY);
  assert.equal(r.approved, false, `approved (${r.reason}); logInclusion.valid=${String(r.logInclusion?.valid)}`);
  assert.match(r.reason, RECEIPT_DENIALS.receipt_leaf_not_a_string);
  assert.equal(r.verifierCalls, 0);
});

test("offline and network verifiers agree: a receipt with no leaf is refused by both", async () => {
  const { extractReceiptLeaf } = await import("../../twzrd-log-verifier/src/client.js");
  const doc = { twzrd_receipt: { preimage: { settlement_tx: "TX_NO_LEAF" } }, log_inclusion: REAL_LOG_INCLUSION };
  assert.throws(() => extractReceiptLeaf(doc), /no 64-hex-char \.leaf/);
  const offline = verifyLogInclusion(doc, DEFAULT_STH_PUBKEY);
  assert.equal(offline.valid, false);
  assert.match(offline.errors.join(" "), /no 64-hex-char \.leaf/);
});

// ---------------------------------------------------------------------------
test("no promise rejection went unhandled", async () => {
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    unhandled.map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))),
    [],
  );
});
