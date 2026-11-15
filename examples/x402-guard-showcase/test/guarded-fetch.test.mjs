// createGuardedX402FetchWithEvents and its helpers, on an in-process seller:
// the transport below answers with Response objects and opens no socket.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { x402Client } from "@x402/fetch";

import {
  createGuardedX402FetchWithEvents,
  describeOffer,
  isHaltReason,
  refusalOf,
  usdcFromBaseUnits,
  verifyReceipt,
} from "../lib/guarded-fetch.mjs";
import { installNetGuard } from "../lib/net-guard.mjs";
import { RAILS } from "../lib/rails.mjs";
import { loadReceipt } from "../lib/receipt.mjs";
import { paymentRequired } from "../lib/seller.mjs";

const guard = installNetGuard();
const scratchDirs = [];
after(() => {
  guard.uninstall();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const ORIGIN = "http://seller.invalid";
const toBase64Json = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

/** A seller in this process: a 402 for an unpaid request, a 200 with `body` for a paid one. */
function fakeSeller({ path = "/good", body = { content: "demo" } } = {}) {
  const required = paymentRequired(path, ORIGIN);
  const seen = { requests: 0, unpaid: 0, paid: 0, payments: [] };
  async function transport(input, init) {
    const request = new Request(input, init);
    seen.requests += 1;
    const signature = request.headers.get("payment-signature");
    if (!signature) {
      seen.unpaid += 1;
      return new Response(JSON.stringify(required), {
        status: 402,
        headers: { "content-type": "application/json", "payment-required": toBase64Json(required) },
      });
    }
    seen.paid += 1;
    seen.payments.push(JSON.parse(Buffer.from(signature, "base64").toString("utf8")));
    const settlement = { success: true, network: RAILS.base.network, transaction: "demo-no-chain", payer: "demo-signer" };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "payment-response": toBase64Json(settlement) },
    });
  }
  return { url: `${ORIGIN}${path}`, seen, transport };
}

/**
 * An x402Client paying Base only, through a demo "exact" scheme that counts its
 * calls. Core's own spend controls are off unless `coreSpendControls` is set.
 */
function demoClient({ coreSpendControls = false } = {}) {
  const scheme = {
    scheme: "exact",
    calls: 0,
    async createPaymentPayload(x402Version) {
      scheme.calls += 1;
      return { x402Version, payload: { demo: true } };
    },
  };
  const config = { schemes: [{ network: RAILS.base.network, client: scheme }] };
  if (coreSpendControls === false) config.spendControls = false;
  const client = x402Client.fromConfig(config);
  return { client, scheme };
}

function sentinelFiles() {
  const dir = mkdtempSync(join(tmpdir(), "x402-guarded-fetch-"));
  scratchDirs.push(dir);
  return { stateDir: dir, killFilePath: join(dir, ".kill"), pauseFilePath: join(dir, ".pause") };
}

function wire({ seller, client, files = sentinelFiles(), ...options }) {
  const events = { decisions: [], kills: [], receipts: [] };
  const pay = createGuardedX402FetchWithEvents({
    client,
    fetch: seller.transport,
    maxPricePerCall: "0.10",
    allowedRecipients: [RAILS.base.sellers.good],
    twzrd: { disabled: true, ...files },
    onDecision: (record) => events.decisions.push(record),
    onKill: (record) => events.kills.push(record),
    onReceiptVerified: (event) => events.receipts.push(event),
    ...options,
  });
  return { pay, events, files };
}

const pick = (record, keys) => Object.fromEntries(keys.map((k) => [k, record[k]]));
const KEYS = ["decision", "reason", "stage", "signerInvocations", "status", "receiptVerified", "chain", "asset", "amountUsdc", "payTo"];

test("allow: one decision record, and the V7 receipt in the paid body verifies", async () => {
  const seller = fakeSeller({ path: "/receipt", body: { twzrd_receipt: loadReceipt() } });
  const { client, scheme } = demoClient();
  const { pay, events } = wire({ seller, client, receipt: true });

  const response = await pay(seller.url);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).twzrd_receipt, "the caller still reads the body");
  assert.equal(scheme.calls, 1);
  assert.deepEqual(pick(seller.seen, ["requests", "unpaid", "paid"]), { requests: 2, unpaid: 1, paid: 1 });
  assert.equal(seller.seen.payments[0].accepted.payTo, RAILS.base.sellers.good);

  assert.equal(events.decisions.length, 1);
  assert.deepEqual(pick(events.decisions[0], KEYS), {
    decision: "allow",
    reason: null,
    stage: "pre_sign",
    signerInvocations: 1,
    status: 200,
    receiptVerified: true,
    chain: "base",
    asset: "USDC",
    amountUsdc: "0.01",
    payTo: RAILS.base.sellers.good,
  });
  assert.equal(typeof events.decisions[0].elapsedMs, "number");
  assert.equal(events.kills.length, 0);
  assert.equal(events.receipts.length, 1);
  assert.equal(events.receipts[0].valid, true);
  assert.equal(events.receipts[0].kind, loadReceipt().kind);
});

test("an edited receipt reads receiptVerified false; without the receipt option nothing is checked", async () => {
  const edited = loadReceipt();
  edited.preimage.score += 1;
  const seller = fakeSeller({ path: "/receipt", body: { twzrd_receipt: edited } });
  const { client } = demoClient();
  const { pay, events } = wire({ seller, client, receipt: true });
  assert.equal((await pay(seller.url)).status, 200, "the payment was already made; the record reports the receipt");
  assert.equal(events.decisions[0].receiptVerified, false);
  assert.ok(events.receipts[0].errors.some((e) => e.startsWith("leaf mismatch")), events.receipts[0].errors.join("; "));

  const plain = fakeSeller({ path: "/receipt", body: { twzrd_receipt: loadReceipt() } });
  const second = demoClient();
  const { pay: payPlain, events: plainEvents } = wire({ seller: plain, client: second.client });
  await payPlain(plain.url);
  assert.equal(plainEvents.decisions[0].receiptVerified, null);
  assert.equal(plainEvents.receipts.length, 0);
});

test("block: a recipient off the allowlist is refused before the scheme is called", async () => {
  const seller = fakeSeller({ path: "/flagged" });
  const { client, scheme } = demoClient();
  const { pay, events } = wire({ seller, client });
  await assert.rejects(pay(seller.url), /unauthorized_recipient/);
  assert.equal(scheme.calls, 0);
  assert.deepEqual(pick(seller.seen, ["requests", "unpaid", "paid"]), { requests: 1, unpaid: 1, paid: 0 });
  assert.deepEqual(pick(events.decisions[0], KEYS), {
    decision: "block",
    reason: "unauthorized_recipient",
    stage: "pre_sign",
    signerInvocations: 0,
    status: null,
    receiptVerified: null,
    chain: "base",
    asset: "USDC",
    amountUsdc: "0.01",
    payTo: RAILS.base.sellers.flagged,
  });
  assert.equal(events.kills.length, 0);
});

test("halt: with .kill or an active .pause nothing is sent, and onKill fires", async () => {
  const cases = [
    { write: (f) => writeFileSync(f.killFilePath, "halt\n"), reason: "twzrd_kill_switch" },
    {
      write: (f) => writeFileSync(f.pauseFilePath, JSON.stringify({ until_unix_ms: Date.now() + 60_000, reason: "operator_review" })),
      reason: "twzrd_payment_paused (operator_review)",
    },
    { write: (f) => writeFileSync(f.pauseFilePath, "not json\n"), reason: "twzrd_pause_corrupt" },
  ];
  for (const { write, reason } of cases) {
    const files = sentinelFiles();
    write(files);
    const seller = fakeSeller();
    const { client, scheme } = demoClient();
    const { pay, events } = wire({ seller, client, files });
    await assert.rejects(pay(seller.url), (error) => error.message === `[twzrd-guarded-fetch] ${reason}`);
    assert.equal(seller.seen.requests, 0, reason);
    assert.equal(scheme.calls, 0, reason);
    assert.equal(events.decisions.length, 1, reason);
    assert.deepEqual(pick(events.decisions[0], ["decision", "reason", "stage", "signerInvocations", "chain"]), {
      decision: "block",
      reason,
      stage: "entry",
      signerInvocations: 0,
      chain: null,
    });
    assert.deepEqual(events.kills, events.decisions, reason);
  }
});

test("a refusal by core's own spend controls is a pre-sign block, not an error", async () => {
  // Core's defaults allow only assets the scheme names as its default; the demo
  // scheme names none, so core refuses every offer while it selects one, before
  // any hook runs. A real @x402/evm or @x402/svm scheme names USDC.
  const seller = fakeSeller();
  const { client, scheme } = demoClient({ coreSpendControls: true });
  const { pay, events } = wire({ seller, client });
  await assert.rejects(pay(seller.url), /spend controls/);
  assert.equal(scheme.calls, 0);
  assert.deepEqual(pick(seller.seen, ["requests", "unpaid", "paid"]), { requests: 1, unpaid: 1, paid: 0 });
  assert.deepEqual(pick(events.decisions[0], ["decision", "reason", "stage", "signerInvocations", "chain"]), {
    decision: "block",
    reason: "core_spend_controls",
    stage: "pre_sign",
    signerInvocations: 0,
    chain: null,
  });
});

test("a callback that throws changes nothing", async () => {
  const seller = fakeSeller();
  const { client } = demoClient();
  const { pay } = wire({
    seller,
    client,
    onDecision: () => {
      throw new Error("telemetry down");
    },
  });
  assert.equal((await pay(seller.url)).status, 200);

  const flagged = fakeSeller({ path: "/flagged" });
  const second = demoClient();
  const { pay: payFlagged } = wire({
    seller: flagged,
    client: second.client,
    onDecision: () => {
      throw new Error("telemetry down");
    },
  });
  await assert.rejects(payFlagged(flagged.url), /unauthorized_recipient/);
});

test("an async callback that rejects changes nothing and leaves no unhandled rejection", async () => {
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    const rejects = async () => {
      throw new Error("telemetry down");
    };
    const seller = fakeSeller({ path: "/receipt", body: { twzrd_receipt: loadReceipt() } });
    const { client } = demoClient();
    const { pay } = wire({ seller, client, receipt: true, onDecision: rejects, onReceiptVerified: rejects });
    assert.equal((await pay(seller.url)).status, 200);

    const files = sentinelFiles();
    writeFileSync(files.killFilePath, "halt\n");
    const halted = fakeSeller();
    const second = demoClient();
    const { pay: payHalted } = wire({ seller: halted, client: second.client, files, onDecision: rejects, onKill: rejects });
    await assert.rejects(payHalted(halted.url), /twzrd_kill_switch/);

    // Node reports an unhandled rejection after the microtask queue drains.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", record);
  }
});

test("a transport failure is reported as an error and rethrown", async () => {
  const { client } = demoClient();
  const failing = {
    transport: async () => {
      throw new TypeError("fetch failed");
    },
  };
  const { pay, events } = wire({ seller: failing, client });
  await assert.rejects(pay(`${ORIGIN}/good`), /fetch failed/);
  assert.deepEqual(pick(events.decisions[0], ["decision", "reason", "stage", "signerInvocations"]), {
    decision: "error",
    reason: "fetch failed",
    stage: null,
    signerInvocations: 0,
  });
  assert.equal(events.kills.length, 0);
});

test("refuses an object that is not an x402Client, and a second install on one client", () => {
  const seller = fakeSeller();
  assert.throws(() => createGuardedX402FetchWithEvents({ client: {}, fetch: seller.transport }), TypeError);
  assert.throws(() => createGuardedX402FetchWithEvents(), TypeError);
  const { client } = demoClient();
  wire({ seller, client });
  assert.throws(() => wire({ seller, client }), /already installed/);
});

test("usdcFromBaseUnits is exact and refuses what is not an integer string", () => {
  assert.equal(usdcFromBaseUnits("10000"), "0.01");
  assert.equal(usdcFromBaseUnits("5000000"), "5.00");
  assert.equal(usdcFromBaseUnits("1"), "0.000001");
  assert.equal(usdcFromBaseUnits("0"), "0.00");
  assert.equal(usdcFromBaseUnits("123456789012345678901"), "123456789012345.678901");
  for (const bad of ["-1", "1.5", "", " 1", "1e6", 10000, null, undefined]) assert.equal(usdcFromBaseUnits(bad), null, String(bad));
});

test("describeOffer names the chain and asset, and leaves amountUsdc null for a token that is not USDC", () => {
  const [base, solana] = paymentRequired("/good", ORIGIN).accepts;
  assert.deepEqual(describeOffer(base), {
    chain: "base",
    network: RAILS.base.network,
    asset: "USDC",
    assetAddress: RAILS.base.usdc,
    payTo: RAILS.base.sellers.good,
    amount: "10000",
    amountUsdc: "0.01",
  });
  assert.equal(describeOffer(solana).chain, "solana");
  assert.equal(describeOffer(solana).asset, "USDC");
  const wrong = describeOffer(paymentRequired("/wrong-asset", ORIGIN).accepts[1]);
  assert.deepEqual([wrong.asset, wrong.assetAddress, wrong.amountUsdc], ["non-USDC", RAILS.solana.nonUsdc, null]);
  assert.equal(describeOffer({ ...base, network: "eip155:1" }).chain, "eip155:1");
  assert.equal(describeOffer({ ...base, amount: undefined, maxAmountRequired: "20000" }).amountUsdc, "0.02");
  assert.ok(Object.values(describeOffer(null)).every((v) => v === null));
});

test("refusalOf reads the gate's refusals and nothing else", () => {
  const wrapped = new Error("Failed to create payment payload: Payment creation aborted: [twzrd-guarded-fetch] price_cap_exceeded");
  assert.deepEqual(refusalOf(wrapped), { reason: "price_cap_exceeded", preSign: true });
  assert.deepEqual(refusalOf(new Error("[twzrd-guarded-fetch] payment_without_approval")), {
    reason: "payment_without_approval",
    preSign: false,
  });
  assert.deepEqual(refusalOf(new Error("Payment creation aborted: [other-hook] seller_denied\ndetail")), {
    reason: "seller_denied",
    preSign: true,
  });
  assert.equal(refusalOf(new TypeError("fetch failed")), null);
  assert.equal(refusalOf(undefined), null);
  assert.equal(isHaltReason("twzrd_payment_paused (operator_review)"), true);
  assert.equal(isHaltReason("price_cap_exceeded"), false);
});

test("verifyReceipt checks offline and never throws", () => {
  assert.equal(verifyReceipt(loadReceipt()).valid, true);
  for (const bad of [null, "receipt", {}, { preimage: null }]) {
    const event = verifyReceipt(bad);
    assert.equal(event.valid, false, JSON.stringify(bad));
    assert.ok(event.errors.length > 0, JSON.stringify(bad));
  }
});

test("no test in this file opened a socket", () => {
  assert.equal(guard.stats.connections, 0);
  assert.equal(guard.stats.refused, 0);
});
