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
 * Two things the outcomes do not mean. A header in another base64 dialect
 * (URL-safe alphabet, padding missing or doubled) is not refused for its
 * encoding: the gate decodes it with Node's decoder, reads the baseline payment
 * out of it, and refuses it here because no entry pays the approved seller. And
 * the receipt path reads a receipt's `leaf` and nothing else in it: the entries
 * that change another field (a score, a timestamp, the signature) are denied
 * because every receipt here sits beside a proof for a different leaf, not
 * because the gate looked at that field.
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
 *       real offline verifier and the real served genesis block, the same wiring
 *       as log-inclusion-offline.test.ts; the receipt bytes are spliced into the
 *       paid response unparsed, so truncated JSON reaches the gate as bytes.
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
import { createTwzrdSettleGuard, type SettleGuardContext } from "../src/seller-hook.js";
import type { X402PaymentRequirements } from "../src/types.js";
import { wrapFetchWithTwzrdGate } from "../src/wrap-fetch.js";
import { verifyLogInclusion } from "../../twzrd-log-verifier/src/client.js";
import { DEFAULT_STH_PUBKEY } from "../../twzrd-log-verifier/src/index.js";

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

// Live genesis block, verbatim from log-inclusion-offline.test.ts (served by
// https://intel.twzrd.xyz/v1/log/sth on 2026-09-04). Real data, offline.
const LIVE_LEAF = "0xf7e88f2666a0590d8cf7d426d4842e29a23b66607f2c0a691bf6fc7d0d63ba8f";
const LIVE_BLOCK = {
  log_id: "intel.twzrd.xyz/v6",
  leaf: LIVE_LEAF,
  leaf_index: 0,
  tree_size: 1,
  audit_path: [] as string[],
  sth: {
    domain: "TWZRD:RECEIPT_LOG_STH_V1",
    log_id: "intel.twzrd.xyz/v6",
    tree_size: 1,
    timestamp_unix: 1788450541,
    root: "0x811e1fee65f06c5cfcfee8f338e933c1d3dd261c4c09b8f2793b62bea7ea6db4",
    signature: "5tgH6Y9x1pcE5eDWjaNb8reUpuy88A5xNanSsJu1A5hEgKbH2kwZtAev6ifE9RWTspkvkvhvuLEGtPbpEN5yVete",
    signing_pubkey: DEFAULT_STH_PUBKEY,
  },
  anchor: null,
  verify: `/v1/log/proof/inclusion?leaf=${LIVE_LEAF}`,
};
const LIVE_RECEIPT = { leaf: LIVE_LEAF, preimage: { settlement_tx: "TX_LIVE" } };
const RECEIPT_REQS = {
  payTo: SELLER,
  maxAmountRequired: "50000",
  resource: RESOURCE,
  network: "solana",
} as X402PaymentRequirements;

const offlineVerifier = async (_receipt: unknown, ctx: { response: unknown }) =>
  verifyLogInclusion(ctx.response, DEFAULT_STH_PUBKEY);

/** Path A with the receipt bytes spliced into the paid /trust response, unparsed, beside `block`. */
function evaluateWithReceiptBytes(receiptRaw: string, block: unknown = LIVE_BLOCK) {
  const body = `{"tx":"TX_FUZZ","twzrd_receipt":${receiptRaw},"log_inclusion":${JSON.stringify(block)}}`;
  return evaluate_x402_resource(RESOURCE, RECEIPT_REQS, {
    fetch: preflight(WARN),
    autoReceipt: true,
    x402Fetch: (async () => json(body)) as unknown as typeof fetch,
    requireLogInclusion: { verifier: offlineVerifier },
  });
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
        // What the description says of it: the decoder the gate uses reads the baseline back.
        assert.equal(Buffer.from(h.value, "base64").toString("utf8"), text, `${f.id}: Node decodes it differently`);
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
  // A base64 dialect is not a refusal by itself: the gate reads the baseline
  // payment out of each of these.
  const dialects = byTarget("header").filter((f) => "encoding" in f.malformation);
  assert.equal(dialects.length, 4);
  for (const f of dialects) {
    assert.equal(paymentBindingRefusal(ownRequirement(f.baseline), f.headers[0].value), undefined, f.id);
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

test("control: the live receipt with its own proof is approved through Path A", async () => {
  const r = await evaluateWithReceiptBytes(JSON.stringify(LIVE_RECEIPT));
  assert.equal(r.approved, true, r.reason);
  assert.equal(r.logInclusion?.valid, true);
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
// Receipts. Every paid response below carries the genuine genesis block, a
// proof for a leaf none of these receipts names. The gate reads a receipt's
// leaf and nothing else in it, so there are three ways to be denied here, and
// `expected_outcome` says which:
//   no_receipt_captured      the paid response is not JSON (the cut-off receipt)
//   leaf_not_named           the receipt names no leaf as a string (the array)
//   leaf_differs_from_proof  the receipt names the V7 example's leaf; the proof
//                            is for the genesis leaf. Nine entries, each with
//                            another field changed that this path does not read.
const RECEIPT_DENIALS: Record<string, RegExp> = {
  no_receipt_captured: /^twzrd_log_inclusion_failed \(no receipt captured: /,
  leaf_not_named: /^twzrd_log_inclusion_failed \(receipt has no 64-hex-char \.leaf field/,
  leaf_differs_from_proof: /^twzrd_log_inclusion_failed \(leaf mismatch: /,
};
for (const f of byTarget("receipt")) {
  test(`receipt ${f.id}: Path A with offline log inclusion denies, no throw`, async () => {
    const r = await evaluateWithReceiptBytes(f.raw_body as string);
    assert.equal(r.approved, false, `${f.id}: approved (${r.reason})`);
    assert.equal(r.logInclusionDenied, true, `${f.id}: denied for another reason: ${r.reason}`);
    assert.match(r.reason, /^twzrd_log_inclusion_(failed|error|pending|tofu_refused)/);
    const expected = RECEIPT_DENIALS[f.expected_outcome];
    assert.ok(expected, `${f.id}: unknown expected_outcome ${f.expected_outcome}`);
    assert.match(r.reason, expected, `${f.id}: expected_outcome`);
  });
}

// The fixtures cannot show this one: their leaf is not the proven leaf. A leaf
// that is not a string is not converted to one. `String([leaf])` prints the
// leaf, so a conversion would read these receipts as naming the proven leaf.
test("a receipt whose leaf is an array holding the proven leaf is denied", async () => {
  for (const leaf of [[LIVE_LEAF], [[LIVE_LEAF]], [LIVE_LEAF.slice(2).toUpperCase()]]) {
    const r = await evaluateWithReceiptBytes(JSON.stringify({ ...LIVE_RECEIPT, leaf }));
    assert.equal(r.approved, false, `approved (${r.reason}) with leaf ${JSON.stringify(leaf)}`);
    assert.equal(r.logInclusionDenied, true);
    assert.match((r.logInclusion?.errors ?? []).join(" "), /no 64-hex-char \.leaf/);
  }
});

test("a proof whose leaf is an array holding the receipt's leaf is denied", async () => {
  const r = await evaluateWithReceiptBytes(JSON.stringify(LIVE_RECEIPT), { ...LIVE_BLOCK, leaf: [LIVE_LEAF] });
  assert.equal(r.approved, false, `approved (${r.reason})`);
  assert.equal(r.logInclusionDenied, true);
  assert.match((r.logInclusion?.errors ?? []).join(" "), /log_inclusion\.leaf: leaf must be a string/);
});

test("receipt with no leaf beside a valid proof for another leaf is denied", async () => {
  const r = await evaluateWithReceiptBytes(JSON.stringify({ preimage: { settlement_tx: "TX_NO_LEAF" } }));
  assert.equal(r.approved, false, `approved (${r.reason}); logInclusion.valid=${String(r.logInclusion?.valid)}`);
  assert.match((r.logInclusion?.errors ?? []).join(" "), /no 64-hex-char \.leaf/);
});

test("offline and network verifiers agree: a receipt with no leaf is refused by both", async () => {
  const { extractReceiptLeaf } = await import("../../twzrd-log-verifier/src/client.js");
  const doc = { twzrd_receipt: { preimage: { settlement_tx: "TX_NO_LEAF" } }, log_inclusion: LIVE_BLOCK };
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
