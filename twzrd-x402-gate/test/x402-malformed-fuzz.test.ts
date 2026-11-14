/**
 * Parser-resilience fuzz: malformed x402 inputs through the gate's real parse points.
 *
 * Fixtures: test/fixtures/x402-malformed-fuzz.json (26 entries, generated offline
 * by a local model from well-formed baselines; no keys, no network; `<tx>` and
 * `<sig>` are placeholders). The file's `description` and `expected_outcome`
 * are the generator's labels. Neither is asserted here, and several do not
 * match the bytes: the two url-safe entries carry the same standard-base64
 * value, one padding entry is correctly padded, and six of the eleven receipts
 * are cut-off JSON whatever their label says. What is asserted, for every entry:
 *
 *   1. it ends in a structured refusal: a refusal code, `approved: false`, a
 *      settle-guard abort, or an Error the gate authored ("[twzrd] payment
 *      blocked: ..."), never an approval;
 *   2. no raw SyntaxError / TypeError / RangeError escapes a gate function;
 *   3. no promise rejection goes unhandled (checked once, last).
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
 * Each entry point also has one well-formed control that must be approved, so a
 * refusal below is the input's doing, not the harness's.
 *
 * Run: npx tsx --test test/x402-malformed-fuzz.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

type FuzzHeader = { name: string; value: string; plaintext?: string; encoding?: string };
type Fixture = {
  id: string;
  category: string;
  description: string;
  target: "header" | "verify_body" | "settle_body" | "receipt";
  headers: FuzzHeader[];
  raw_body: string | null;
  expected_outcome: string;
};

const FILE = JSON.parse(
  readFileSync(new URL("./fixtures/x402-malformed-fuzz.json", import.meta.url), "utf8"),
) as { fixtureCount: number; fixtures: Fixture[] };
const FIXTURES = FILE.fixtures;

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

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

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

/** Path A with the receipt bytes spliced into the paid /trust response, unparsed. */
function evaluateWithReceiptBytes(receiptRaw: string) {
  const body = `{"tx":"TX_FUZZ","twzrd_receipt":${receiptRaw},"log_inclusion":${JSON.stringify(LIVE_BLOCK)}}`;
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
// Receipts. Every paid response below carries the genuine genesis block, so a
// denial comes from the receipt itself. Six of the eleven are cut-off JSON:
// the paid response does not parse and no receipt is captured. The other five
// parse and name no leaf.
for (const f of byTarget("receipt")) {
  test(`receipt ${f.id}: Path A with offline log inclusion denies, no throw`, async () => {
    const r = await evaluateWithReceiptBytes(f.raw_body as string);
    assert.equal(r.approved, false, `${f.id}: approved (${r.reason})`);
    assert.equal(r.logInclusionDenied, true, `${f.id}: denied for another reason: ${r.reason}`);
    assert.match(r.reason, /^twzrd_log_inclusion_(failed|error|pending|tofu_refused)/);
  });
}

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
