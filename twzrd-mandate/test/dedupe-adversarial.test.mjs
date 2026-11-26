// Adversarial review of the duplicate-purchase check (layer 4, `duplicate_purchase`).
// Every test here is one suspected bug and asserts the behavior SPEC.md and the
// commit message promise; each one fails against the code as it stands.
// Everything runs on loopback with an injected clock; nothing sleeps on real time.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  MCP_IDEMPOTENCY_META,
  STATE_FILES,
  createHttpUpstream,
  createMandateRuntime,
  createMcpGateway,
  loopbackOnlyFetch,
} from "../dist/index.js";
import { makeRig } from "./helpers.mjs";

const rows = (stateDir) =>
  fs.readFileSync(path.join(stateDir, STATE_FILES.decisionLedger), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const KEY = (k) => ({ headers: { "idempotency-key": k } });
const enc = (s) => new TextEncoder().encode(s);

// ---- clock steps ----------------------------------------------------------

// Claim broken: "an identical call is refused ... for dedupeWindowSeconds after a
// paid one ends" and "a clock stepped back holds for at most one window".
// Scenario: a purchase settles; the wall clock is then stepped back by more than
// one window (NTP correction, VM restore, operator fix) and the agent retries
// the identical call a moment later. The check uses |now - at| < window, so a
// negative age larger than the window reads as "long ago" and the retry pays.
// Why it matters: double-pay of the exact purchase the check exists to stop,
// zero real seconds after the first payment. A backward step should at most
// restart the window (treat negative age as 0), never open it. (The existing
// v0-gaps clock test asserts this double-pay as intended; it should not be.)
test("clock stepped back by more than a window right after a payment must not let the identical purchase pay again", async () => {
  const rig = await makeRig();
  try {
    assert.equal((await rig.buy("ok", KEY("step-back"))).outcome, "settled");
    rig.clock.now -= 2 * 3_600_000; // wall clock stepped back two hours, no real time passed
    const retry = await rig.buy("ok", KEY("step-back"));
    assert.equal(retry.refusal?.code, "duplicate_purchase", `retry outcome ${retry.outcome}: the same purchase was paid twice`);
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [1, 1]);
  } finally {
    await rig.close();
  }
});

// Claim broken: "a clock stepped back holds for at most one window" (code comment:
// "not the step plus a window").
// Scenario: purchase settles at T; clock steps back 50 s (observed by a refused
// retry); then 61 s really pass (clock = T + 11 s). Since the step, more than a
// full window has elapsed, yet |age| = 11 s < 60 s, so the purchase is still
// refused. The hold is step + window (here 111 s), exactly what the comment says
// it avoids; with a step close to 86400 s window it is up to two days.
// Why it matters: DoS of a legitimate re-purchase beyond the documented bound.
test("clock stepped back by less than a window holds the purchase for step + window, not at most one window", async () => {
  const rig = await makeRig();
  try {
    assert.equal((await rig.buy("ok", KEY("small-step"))).outcome, "settled");
    rig.clock.now -= 50_000;
    assert.equal((await rig.buy("ok", KEY("small-step"))).refusal?.code, "duplicate_purchase");
    rig.clock.now += 61_000; // a full window and a second since the step was seen
    const later = await rig.buy("ok", KEY("small-step"));
    assert.equal(later.outcome, "settled", `still refused (${later.refusal?.code}): ${later.refusal?.detail}`);
  } finally {
    await rig.close();
  }
});

// ---- the key is computed from the agent's input, not the request that is sent ----

// Claim broken: "each paid call is hashed (method, full URL, ...)"; an identical
// call is refused. The key uses target.href, which keeps the #fragment, but a
// fragment is never sent: the seller receives byte-identical requests.
// Scenario: the same URL with "#a" and then "#b" (same Idempotency-Key). Both
// settle. Why it matters: double-pay for one identical on-the-wire purchase;
// a client that appends a cache-busting or anchor fragment defeats the check.
// (A bare trailing "?" has the same effect: href keeps it, the wire does not.)
test("a URL fragment, which is never sent to the seller, makes an identical purchase look new", async () => {
  const rig = await makeRig();
  try {
    const url = rig.world.url("ok");
    const first = await rig.runtime.call({ tool: rig.tool, url: `${url}#a`, ...KEY("frag") });
    assert.equal(first.outcome, "settled", `${first.record.code} ${first.record.detail}`);
    const second = await rig.runtime.call({ tool: rig.tool, url: `${url}#b`, ...KEY("frag") });
    assert.equal(second.refusal?.code, "duplicate_purchase", `second outcome ${second.outcome}: paid twice for one request`);
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [1, 1]);
  } finally {
    await rig.close();
  }
});

// Claim broken: identical calls are refused. buildInit drops the body of a GET
// or HEAD, so the seller gets the same request whatever body the agent passed,
// but purchaseKey hashes that body anyway.
// Scenario: two GETs to the same URL with the same Idempotency-Key and bodies
// "a" and "b". Recorded on the wire they are identical. Both settle.
// Why it matters: double-pay; any client that attaches a (varying) body to a
// GET retry, e.g. a timestamped JSON payload, is never deduplicated.
test("a GET body that is never sent still changes the key, so an identical GET pays twice", async () => {
  const wire = [];
  const lf = loopbackOnlyFetch();
  const recording = async (input, init) => {
    const h = new Headers(init?.headers);
    if (h.get("x-payment")) wire.push(JSON.stringify([init?.method, String(input).split("#")[0], init?.body === undefined ? null : String(init.body), h.get("idempotency-key")]));
    return lf.fetch(input, init);
  };
  const rig = await makeRig({ runtime: { fetch: recording } });
  try {
    const url = rig.world.url("ok");
    const first = await rig.runtime.call({ tool: rig.tool, url, method: "GET", body: enc("a"), ...KEY("get-body") });
    assert.equal(first.outcome, "settled", `${first.record.code} ${first.record.detail}`);
    const second = await rig.runtime.call({ tool: rig.tool, url, method: "GET", body: enc("b"), ...KEY("get-body") });
    if (wire.length === 2) assert.equal(wire[0], wire[1], "the two paid requests on the wire are identical");
    assert.equal(second.refusal?.code, "duplicate_purchase", `second outcome ${second.outcome}: paid twice for one request`);
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [1, 1]);
  } finally {
    await rig.close();
  }
});

// Claim broken: identical calls (same Idempotency-Key) are refused. The key reads
// the raw header value; the outgoing request goes through Headers, which strips
// leading/trailing whitespace, so "k" and " k " reach the seller as the same key.
// Scenario: same URL, Idempotency-Key "k" then " k ". The seller sees two
// requests with Idempotency-Key "k"; the mandate pays both.
// Why it matters: double-pay, and the seller's own idempotency handling is told
// these are the same purchase while the mandate treats them as different.
test("Idempotency-Key whitespace that the outgoing request strips makes an identical purchase look new", async () => {
  const sentKeys = [];
  const lf = loopbackOnlyFetch();
  const recording = async (input, init) => {
    const h = new Headers(init?.headers);
    if (h.get("x-payment")) sentKeys.push(h.get("idempotency-key"));
    return lf.fetch(input, init);
  };
  const rig = await makeRig({ runtime: { fetch: recording } });
  try {
    assert.equal((await rig.buy("ok", KEY("k"))).outcome, "settled");
    const second = await rig.buy("ok", KEY(" k "));
    if (sentKeys.length === 2) assert.equal(sentKeys[0], sentKeys[1], "the seller saw the same Idempotency-Key twice");
    assert.equal(second.refusal?.code, "duplicate_purchase", `second outcome ${second.outcome}: paid twice for one key`);
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [1, 1]);
  } finally {
    await rig.close();
  }
});

// ---- MCP keying -----------------------------------------------------------

// Claim broken: params._meta["twzrd/idempotency-key"] names a new purchase.
// A non-string value (a number, which JSON-RPC clients commonly use for counters)
// is silently treated as "no key", so key 1 and key 2 are the same purchase.
// Scenario: tools/call paid_lookup {q:"x"} with _meta key 1 (pays), then the same
// call with _meta key 2: refused as duplicate_purchase. Correct behavior is
// either a new purchase or an explicit error for a malformed key, never a
// silent collision. Why it matters: false refusal (DoS) of a purchase the
// agent explicitly marked as new, with a refusal message telling it to do
// exactly what it already did.
test("MCP: a non-string twzrd/idempotency-key is silently dropped, so two different keys collide", async () => {
  const rig = await makeRig();
  const gw = createMcpGateway(rig.runtime, createHttpUpstream(rig.world.mcpUrl, { fetch: rig.guard.fetch }));
  const call = (id, meta) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "paid_lookup", arguments: { q: "x" }, _meta: meta } });
  const code = (reply) => reply?.result?.structuredContent?.twzrd_mandate?.code ?? (reply?.result ? "delivered" : reply?.error?.message);
  try {
    assert.equal(code(await gw.handleMessage(call(1, { [MCP_IDEMPOTENCY_META]: 1 }))), "delivered");
    const second = code(await gw.handleMessage(call(2, { [MCP_IDEMPOTENCY_META]: 2 })));
    assert.notEqual(second, "duplicate_purchase", "idempotency key 2 was refused as the same purchase as key 1");
  } finally {
    gw.close();
    await rig.close();
  }
});

// ---- restart / ledger -----------------------------------------------------

// Claim broken (SPEC, ledger section): dedupeKey is present "on the outcome line
// of a call that chose an offer". After a crash mid-payment, the restart writes
// the outcome line for the orphaned pending line (violation, payment_unresolved,
// ref -> pending.seq) without dedupeKey, so the ledger cannot tie that
// outcome to the purchase, and the rebuild ("from pending/settled/violation
// lines") never sees the violation line as the end of that call.
// Scenario: paid call hangs after its payment leaves; the runtime is closed
// (stand-in for a crash) and reopened on the same state directory.
// Why it matters: ledger integrity: the one outcome line most in need of
// audit (a payment whose result is unknown) is the one missing the purchase key.
test("restart: the payment_unresolved outcome line for a crashed payment carries no dedupeKey", async () => {
  const lf = loopbackOnlyFetch();
  let paymentLeft = false;
  const hangAfterPayment = async (input, init) => {
    if (new Headers(init?.headers).get("x-payment")) {
      paymentLeft = true;
      return new Promise(() => {}); // the process "dies" with the payment out
    }
    return lf.fetch(input, init);
  };
  const rig = await makeRig({ runtime: { fetch: hangAfterPayment } });
  let reopened;
  try {
    rig.buy("ok", KEY("crash")).catch(() => {});
    for (let i = 0; i < 400 && !paymentLeft; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(paymentLeft, true, "harness: the payment never left");
    rig.runtime.close();
    reopened = createMandateRuntime({
      mandate: rig.mandate,
      expiresAtMs: rig.expiresAtMs,
      stateDir: rig.stateDir,
      intelBase: rig.world.intelBase,
      fetch: rig.guard.fetch,
      agentKey: rig.agentKey,
      now: () => rig.clock.now,
      receiptMaxAgeSeconds: null,
      refuseReceiptReplay: false,
      wrapPay: rig.payer.wrapPay,
    });
    const ledger = rows(rig.stateDir);
    const pending = ledger.find((r) => r.outcome === "pending");
    assert.match(pending?.dedupeKey ?? "", /^[0-9a-f]{64}$/, "harness: pending line with a dedupeKey");
    const outcome = ledger.find((r) => r.ref === pending.seq);
    assert.equal(outcome?.code, "payment_unresolved", "harness: restart answered the orphan");
    assert.equal(outcome.dedupeKey, pending.dedupeKey, "the outcome line of the crashed purchase names no purchase");
  } finally {
    reopened?.close();
    await rig.world.close();
  }
});
