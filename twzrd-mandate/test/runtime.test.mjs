// The enforcement runtime, against the loopback world. Every refusal here is
// checked three ways: the code, the payer's signature count, and what the
// seller actually received.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BASE_USDC,
  LOOPBACK_BASE_SELLER,
  LOOPBACK_SELLER,
  LOOPBACK_WASH_SELLER,
  SOLANA_USDC,
  STATE_FILES,
  createMandateRuntime,
  verifyDecisionLedger,
} from "../dist/index.js";
import { bodyJson, makeRig } from "./helpers.mjs";

function assertRefused(rig, result, layer, code) {
  assert.equal(result.outcome, "refused", `${result.outcome}: ${result.record.code} ${result.record.detail}`);
  assert.equal(result.refusal.code, code, result.refusal.detail);
  assert.equal(result.refusal.layer, layer);
  assert.equal(result.signatures, 0);
  assert.equal(result.status, 403);
  assert.equal(result.delivered, false);
  assert.equal(rig.payer.signatures, 0, "the payer signed");
  assert.equal(rig.world.paidCount, 0, "the seller was paid");
  const doc = bodyJson(result);
  assert.equal(doc.error.code, code);
  assert.equal(doc.error.signatures, 0);
}

test("an allowed call settles: one signature, receipt and inclusion verified, spend recorded", async () => {
  const rig = await makeRig();
  try {
    const result = await rig.buy("ok");
    assert.equal(result.outcome, "settled");
    assert.equal(result.status, 200);
    assert.deepEqual([result.signatures, rig.payer.signatures, rig.world.paidCount], [1, 1, 1]);
    assert.deepEqual([result.quotedUsd, result.settledUsd, result.payTo], ["0.01", "0.01", LOOPBACK_SELLER]);
    assert.deepEqual([result.receipt.status, result.receipt.version, result.inclusion.status], ["verified", "v7", "proven"]);
    assert.equal(bodyJson(result).answer, 42);
    const status = rig.runtime.status();
    assert.deepEqual([status.spend.dayUsd, status.spend.remainingDayUsd, status.counters.settledUsd], ["0.01", "0.99", "0.01"]);
    assert.equal(result.record.outcome, "settled");
    assert.equal(rig.guard.strays.length, 0);
  } finally {
    await rig.close();
  }
});

test("a free call passes through and is logged, with no trust lookup and no signature", async () => {
  const rig = await makeRig();
  try {
    rig.world.product("gratis").free = true;
    const result = await rig.buy("gratis");
    assert.deepEqual([result.outcome, result.status, result.signatures], ["free", 200, 0]);
    assert.deepEqual(rig.world.hits, ["free:gratis"]);
    assert.equal(rig.runtime.ledger.count(), 1);
  } finally {
    await rig.close();
  }
});

test("layer 1: an expired mandate refuses, and expiry mid-call stops the payment", async () => {
  const rig = await makeRig();
  try {
    rig.clock.now += 3_600_000;
    assertRefused(rig, await rig.buy("ok"), 1, "mandate_expired");
    assert.equal(rig.world.hits.length, 0, "an expired mandate sent a request");
  } finally {
    await rig.close();
  }
  const late = await makeRig();
  try {
    // The mandate expires while the trust lookup is in flight.
    late.world.hook = (event) => {
      if (event === "preflight") late.clock.now += 3_600_000;
    };
    assertRefused(late, await late.buy("ok"), 1, "mandate_expired");
  } finally {
    await late.close();
  }
});

test("layer 2: the kill file stops free and paid calls; a pause stops paid calls", async () => {
  const rig = await makeRig();
  try {
    rig.world.product("gratis").free = true;
    rig.runtime.kill("test");
    assertRefused(rig, await rig.buy("ok"), 2, "kill_switch");
    assertRefused(rig, await rig.buy("gratis"), 2, "kill_switch");
    assert.equal(rig.world.hits.length, 0);
    assert.deepEqual(rig.runtime.resume().removed, [".kill"]);
    assert.equal((await rig.buy("ok")).outcome, "settled");
  } finally {
    await rig.close();
  }
  const paused = await makeRig();
  try {
    fs.writeFileSync(path.join(paused.stateDir, STATE_FILES.pause), "not a pause document");
    // A pause file that cannot be read is a pause, not a pass.
    assertRefused(paused, await paused.buy("ok"), 2, "payment_gate_halt");
  } finally {
    await paused.close();
  }
});

test("layer 2: a kill that lands while the trust lookup is in flight still stops the payment", async () => {
  const rig = await makeRig();
  try {
    rig.world.hook = (event) => {
      if (event === "merchant_card") fs.writeFileSync(path.join(rig.stateDir, STATE_FILES.kill), "now\n");
    };
    const result = await rig.buy("ok");
    assert.equal(result.outcome, "refused");
    assert.equal(result.refusal.code, "kill_switch");
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [0, 0]);
  } finally {
    await rig.close();
  }
});

test("layer 3: a tool off the allow-list is refused before any request leaves", async () => {
  const rig = await makeRig();
  try {
    const result = await rig.runtime.call({ tool: "http:evil.example", url: rig.world.url("ok") });
    assertRefused(rig, result, 3, "tool_not_allowed");
    assert.equal(rig.world.hits.length, 0);
  } finally {
    await rig.close();
  }
});

test("layer 4: per-call cap, then the daily budget, then the monthly ceiling", async () => {
  const rig = await makeRig({ mandate: { maxPerCallUsd: "0.03", dailyCeilingUsd: "0.05" } });
  try {
    rig.world.product("dear").priceMicro = 30_001;
    assertRefused(rig, await rig.buy("dear"), 4, "per_request_cap");
    rig.world.product("ok").priceMicro = 30_000;
    assert.equal((await rig.buy("ok")).outcome, "settled");
    const second = await rig.buy("ok");
    assert.deepEqual([second.outcome, second.refusal.code, second.refusal.layer, second.signatures], ["refused", "budget_exceeded", 4, 0]);
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount, rig.world.receivedMicro], [1, 1, 30_000]);
  } finally {
    await rig.close();
  }
  const monthly = await makeRig({ mandate: { maxPerCallUsd: "0.03", hourlyCeilingUsd: "0.03", dailyCeilingUsd: "0.03", monthlyCeilingUsd: "0.05", lifetimeMs: 30 * 86_400_000 } });
  try {
    monthly.world.product("ok").priceMicro = 30_000;
    assert.equal((await monthly.buy("ok")).outcome, "settled");
    // A day later the hour and day windows are clear; only the 30-day ceiling still holds this spend.
    monthly.clock.now += 25 * 3_600_000;
    const real = Date.now;
    Date.now = () => monthly.clock.now;
    try {
      const next = await monthly.buy("ok");
      assert.deepEqual([next.outcome, next.refusal?.code, next.signatures], ["refused", "monthly_ceiling_exceeded", 0], next.record.detail);
    } finally {
      Date.now = real;
    }
    assert.equal(monthly.payer.signatures, 1);
  } finally {
    await monthly.close();
  }
});

test("layer 4: twenty concurrent calls cannot pass the daily ceiling", async () => {
  const rig = await makeRig({ mandate: { maxPerCallUsd: "0.01", dailyCeilingUsd: "0.05" } });
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => rig.buy("ok")));
    const settled = results.filter((r) => r.outcome === "settled");
    const refused = results.filter((r) => r.outcome === "refused");
    assert.equal(settled.length, 5, results.map((r) => `${r.outcome}:${r.record.code}`).join(" "));
    assert.equal(refused.length, 15);
    for (const r of refused) assert.deepEqual([r.refusal.code, r.signatures], ["budget_exceeded", 0]);
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount, rig.world.receivedMicro], [5, 5, 50_000]);
    assert.equal(rig.runtime.status().spend.remainingDayUsd, "0");
    assert.equal(rig.runtime.ledger.verify().ok, true);
  } finally {
    await rig.close();
  }
});

test("layer 5: wash flag, low score, block decision, trust service down, chain, counterparty lists", async () => {
  const cases = [
    [{}, (w) => (w.product("x").payTo = LOOPBACK_WASH_SELLER), "trust_gate_refused"],
    [{}, (w) => (w.defaultTrust = { decision: "allow", score: 74, washFlagged: false }), "trust_gate_refused"],
    [{}, (w) => (w.defaultTrust = { decision: "block", score: 5, washFlagged: false }), "trust_gate_refused"],
    [{}, (w) => (w.trustDown = true), "trust_gate_refused"],
    [{}, (w) => Object.assign(w.product("x"), { network: "base", asset: BASE_USDC, payTo: LOOPBACK_BASE_SELLER }), "chain_not_allowed"],
    [{}, (w) => (w.product("x").network = "solana-devnet"), "chain_not_allowed"],
    [{ blockedCounterparties: [LOOPBACK_SELLER] }, () => {}, "counterparty_blocked"],
    [{ allowedCounterparties: [LOOPBACK_WASH_SELLER] }, () => {}, "counterparty_not_allowed"],
  ];
  for (const [mandate, arrange, code] of cases) {
    const rig = await makeRig({ mandate });
    try {
      arrange(rig.world);
      assertRefused(rig, await rig.buy("x"), 5, code);
    } finally {
      await rig.close();
    }
  }
  // The score is compared at the threshold exactly: 75 passes a minimum of 75.
  const edge = await makeRig();
  try {
    edge.world.defaultTrust = { decision: "allow", score: 75, washFlagged: false };
    assert.equal((await edge.buy("ok")).outcome, "settled");
  } finally {
    await edge.close();
  }
});

test("layer 6: a 402 the runtime cannot read or price is refused, never passed to the payer", async () => {
  const cases = [
    [(p) => (p.challenge = "noncanonical-header"), "payment_required_unreadable"],
    [(p) => (p.challenge = "garbage"), "payment_required_unreadable"],
    [(p) => (p.challenge = "mpp"), "payment_required_unreadable"],
    [(p) => (p.asset = "So11111111111111111111111111111111111111112"), "unpriced_offer"],
    [(p) => (p.scheme = "upto"), "payment_required_unreadable"],
    [(p) => (p.priceMicro = 0), "unpriced_offer"],
    [(p) => (p.payTo = "not-a-wallet"), "payment_required_unreadable"],
    [(p) => (p.extraOffers = Array.from({ length: 8 }, () => ({ payTo: LOOPBACK_SELLER, amount: "1", network: "solana", asset: SOLANA_USDC }))), "payment_required_unreadable"],
    [(p) => (p.swapPayToAfterFirst = LOOPBACK_WASH_SELLER), "offer_changed_after_approval"],
  ];
  for (const [arrange, code] of cases) {
    const rig = await makeRig();
    try {
      arrange(rig.world.product("x"));
      const result = await rig.buy("x");
      assertRefused(rig, result, 6, code);
    } finally {
      await rig.close();
    }
  }
  const noPayer = await makeRig({ payer: false });
  try {
    assertRefused(noPayer, await noPayer.buy("ok"), 6, "no_payer_configured");
  } finally {
    await noPayer.close();
  }
});

test("a header challenge in canonical base64 is read and paid", async () => {
  const rig = await makeRig();
  try {
    rig.world.product("hdr").challenge = "header";
    const result = await rig.buy("hdr");
    assert.deepEqual([result.outcome, result.signatures], ["settled", 1], result.record.detail);
  } finally {
    await rig.close();
  }
});

test("with several offers the payer is handed only the cheapest one the mandate allows", async () => {
  const rig = await makeRig();
  try {
    const product = rig.world.product("multi");
    product.priceMicro = 20_000;
    // First in the list, and what a payer that takes accepts[0] would sign: a wash seller at a higher price.
    product.extraOffers = [
      { scheme: "exact", payTo: LOOPBACK_BASE_SELLER, amount: "5000", network: "base", asset: BASE_USDC },
      { scheme: "exact", payTo: LOOPBACK_WASH_SELLER, amount: "900000", network: "solana", asset: SOLANA_USDC },
    ];
    const result = await rig.buy("multi");
    // The Base offer is cheaper but the mandate is Solana-only; the 0.90 offer is over the per-call cap.
    assert.deepEqual([result.outcome, result.payTo, result.quotedUsd, result.signatures], ["settled", LOOPBACK_SELLER, "0.02", 1], result.record.detail);
    assert.equal(rig.world.receivedMicro, 20_000);
  } finally {
    await rig.close();
  }
});

test("billing: the signed amount is what is recorded; a seller report that differs from it pauses spending", async () => {
  // Security review finding 1: recording the seller's lower report let a
  // seller (or a forged header) shrink the hourly and daily windows.
  const lower = await makeRig();
  try {
    lower.world.product("ok").billMicro = 4_000;
    const result = await lower.buy("ok");
    assert.deepEqual([result.outcome, result.quotedUsd, result.settledUsd, result.refusal.code], ["violation", "0.01", "0.01", "settlement_tripped"]);
    assert.match(result.record.detail, /reports 0\.004 USD settled, but 0\.01 USD was signed/);
    assert.equal(lower.runtime.status().spend.dayUsd, "0.01");
    assert.equal(lower.runtime.status().halt.active, true);
    assert.equal((await lower.buy("ok")).refusal.code, "payment_gate_halt");
    assert.equal(lower.payer.signatures, 1);
  } finally {
    await lower.close();
  }
  const silent = await makeRig();
  try {
    silent.world.product("ok").settlementHeader = false;
    const result = await silent.buy("ok");
    assert.deepEqual([result.outcome, result.settledUsd], ["settled", "0.01"]);
    assert.match(result.record.detail, /signed amount/);
  } finally {
    await silent.close();
  }
  const noAmount = await makeRig();
  try {
    noAmount.world.product("ok").settlementHeader = Buffer.from(JSON.stringify({ success: true, transaction: "t" })).toString("base64");
    assert.deepEqual([(await noAmount.buy("ok")).settledUsd], ["0.01"]);
  } finally {
    await noAmount.close();
  }
  const higher = await makeRig();
  try {
    higher.world.product("ok").billMicro = 40_000;
    const result = await higher.buy("ok");
    // The seller says it took more than was signed for. The signature bounds what can have moved; spending stops.
    assert.equal(result.outcome, "violation");
    assert.equal(result.settledUsd, "0.01");
    assert.equal(higher.runtime.status().halt.active, true);
    assert.equal((await higher.buy("ok")).refusal.code, "payment_gate_halt");
    assert.equal(higher.payer.signatures, 1);
  } finally {
    await higher.close();
  }
});

test("billing: an unreadable settlement header records the worst case and pauses", async () => {
  const headers = [
    "%%%not-base64%%%",
    `${Buffer.from(JSON.stringify({ success: true, amount: "10000" })).toString("base64")}=`, // not canonical base64
    Buffer.from("not json").toString("base64"),
    Buffer.from(JSON.stringify({ success: true, amount: -5 })).toString("base64"),
    Buffer.from(JSON.stringify({ success: true, amount: "1e4" })).toString("base64"),
    Buffer.from(JSON.stringify({ success: false, amount: "10000" })).toString("base64"),
    Buffer.from(JSON.stringify([1])).toString("base64"),
  ];
  for (const header of headers) {
    const rig = await makeRig();
    try {
      rig.world.product("ok").settlementHeader = header;
      const result = await rig.buy("ok");
      assert.equal(result.outcome, "violation", `${header}: ${result.outcome}`);
      // The payer signed an exact offer of 0.01: that is the most the seller can have taken.
      assert.equal(result.settledUsd, "0.01", "the worst case is the signed amount");
      assert.equal(rig.runtime.status().halt.active, true);
      assert.equal(rig.runtime.status().spend.dayUsd, "0.01");
    } finally {
      await rig.close();
    }
  }
});

test("a seller that takes the payment and answers non-2xx: worst case recorded, spending paused, nothing delivered", async () => {
  for (const status of [500, 402, 302, 404]) {
    const rig = await makeRig();
    try {
      rig.world.product("ok").afterPayStatus = status;
      const result = await rig.buy("ok");
      assert.equal(result.outcome, "violation", `${status}`);
      assert.deepEqual([result.refusal.code, result.signatures, result.status, result.delivered], ["paid_call_failed", 1, 502, false]);
      assert.equal(result.settledUsd, "0.01", "the signed amount is recorded as spent");
      assert.equal(rig.world.paidCount, 1);
      const next = await rig.buy("ok");
      assert.deepEqual([next.outcome, next.refusal.code, next.signatures], ["refused", "payment_gate_halt", 0]);
      assert.equal(rig.payer.signatures, 1, "a second payment was signed after the trip");
    } finally {
      await rig.close();
    }
  }
});

test("receipts: missing, forged, replayed about another wallet, or unproven means withheld and paused", async () => {
  const receipt = () => JSON.parse(fs.readFileSync(new URL("../fixtures/receipt-v7.json", import.meta.url), "utf8"));
  const inclusion = () => JSON.parse(fs.readFileSync(new URL("../fixtures/receipt-v7-log-inclusion.json", import.meta.url), "utf8"));
  const cases = [
    ["receipt_missing", (p) => (p.receipt = null)],
    ["receipt_invalid", (p) => (p.receipt = { ...receipt(), signature: Buffer.alloc(64).toString("base64") })],
    ["receipt_invalid", (p) => (p.receipt = { ...receipt(), preimage: { ...receipt().preimage, score: 99 } })],
    ["receipt_invalid", (p) => (p.receipt = { ...receipt(), preimage: { ...receipt().preimage, agent_id: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" } })],
    ["receipt_invalid", (p) => (p.receipt = { ...receipt(), preimage: { ...receipt().preimage, recheck_after_unix: 1 } })],
    ["receipt_invalid", (p) => (p.receipt = "receipt")],
    ["inclusion_unproven", (p) => (p.inclusion = { ...inclusion(), leaf_index: 3 })],
    ["inclusion_unproven", (p) => (p.inclusion = { ...inclusion(), audit_path: [] })],
    ["inclusion_unproven", (p) => (p.inclusion = null)],
  ];
  for (const [code, arrange] of cases) {
    const rig = await makeRig();
    try {
      arrange(rig.world.product("ok"));
      const result = await rig.buy("ok");
      assert.equal(result.outcome, "violation", `${code}: ${result.outcome} ${result.record.detail}`);
      assert.equal(result.refusal.code, code, result.record.detail);
      assert.deepEqual([result.delivered, result.status, result.signatures], [false, 502, 1]);
      assert.equal(JSON.stringify(bodyJson(result)).includes('"answer"'), false, "the withheld answer leaked");
      assert.equal(rig.runtime.status().halt.active, true);
      assert.equal(rig.guard.strays.length, 0, "an inclusion check left loopback");
    } finally {
      await rig.close();
    }
  }
  // The key a receipt names for itself is a label. Verification is under the pinned key only,
  // so a receipt with a swapped label verifies under the pinned key or not at all.
  const label = await makeRig();
  try {
    label.world.product("ok").receipt = { ...receipt(), signing_pubkey: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" };
    const result = await label.buy("ok");
    assert.equal(result.outcome, "settled");
    assert.match(result.receipt.detail, /verified under Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS/);
  } finally {
    await label.close();
  }
  // The recorded receipt is about TWZRD's seller wallet. Paid to another wallet it is a replay.
  const replay = await makeRig({ mandate: { minTrustScore: 0 } });
  try {
    replay.world.product("ok").payTo = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const result = await replay.buy("ok");
    assert.deepEqual([result.outcome, result.refusal.code], ["violation", "receipt_invalid"], result.record.detail);
    assert.match(result.record.detail, /did not name/);
  } finally {
    await replay.close();
  }
});

test("a mandate that requires no receipt delivers the answer and still reports what it saw", async () => {
  const rig = await makeRig({ mandate: { requireV7Receipt: false, requireMerkleInclusion: false } });
  try {
    rig.world.product("bare").receipt = null;
    rig.world.product("bare").inclusion = null;
    const result = await rig.buy("bare");
    assert.deepEqual([result.outcome, result.receipt.status, result.inclusion.status], ["settled", "absent", "not_checked"]);
    const withReceipt = await rig.buy("ok");
    assert.deepEqual([withReceipt.receipt.status, withReceipt.inclusion.status], ["verified", "proven"]);
  } finally {
    await rig.close();
  }
});

test("an agent cannot hand the runtime a payment of its own to forward", async () => {
  const rig = await makeRig();
  try {
    const forged = Buffer.from(JSON.stringify({ payTo: LOOPBACK_SELLER, amount: "10000", nonce: "x", signature: "AA==" })).toString("base64");
    const result = await rig.buy("ok", { headers: { "x-payment": forged, "payment-signature": forged } });
    // The header is dropped, the seller answers 402, and the call goes through the pipeline as usual.
    assert.equal(result.outcome, "settled");
    assert.deepEqual(rig.world.hits.filter((h) => h.startsWith("payment")).length, 1);
  } finally {
    await rig.close();
  }
});

test("environment variables on the host cannot loosen a mandate", async () => {
  const hostile = {
    TWZRD_FAIL_OPEN: "1",
    TWZRD_PREFLIGHT_MIN_SCORE: "0",
    TWZRD_REFUSE_WASH_FLAGGED: "0",
    TWZRD_REFUSE_WASH_UNKNOWN: "0",
    TWZRD_REFUSE_UNEVALUATED: "0",
    TWZRD_WASH_MAX_USDC: "1000",
    TWZRD_BLOCK_DECISIONS: "none",
    TWZRD_UNSUPPORTED_NETWORK_MODE: "allow",
    TWZRD_INTEL_BASE: "http://127.0.0.1:9/",
    TWZRD_STATE_DIR: "/nonexistent-state-dir",
    KILLSWITCH_MAX_USD_DAY: "1000000",
  };
  const arrange = [
    [(w) => (w.product("x").payTo = LOOPBACK_WASH_SELLER), "trust_gate_refused"],
    [(w) => (w.defaultTrust = { decision: "allow", score: 10, washFlagged: false }), "trust_gate_refused"],
    [(w) => (w.defaultTrust = { decision: "block", score: 5, washFlagged: false }), "trust_gate_refused"],
    [(w) => (w.trustDown = true), "trust_gate_refused"],
  ];
  for (const [setup, code] of arrange) {
    const rig = await makeRig({ mandate: { maxPerCallUsd: "0.02", dailyCeilingUsd: "0.02" } });
    Object.assign(process.env, hostile);
    try {
      setup(rig.world);
      assertRefused(rig, await rig.buy("x"), 5, code);
      // And the kill file in the mandate's own state directory still governs, not TWZRD_STATE_DIR.
      rig.world.trustDown = false;
      rig.world.defaultTrust = { decision: "allow", score: 90, washFlagged: false };
      rig.runtime.kill();
      assertRefused(rig, await rig.buy("ok"), 2, "kill_switch");
    } finally {
      for (const key of Object.keys(hostile)) delete process.env[key];
      await rig.close();
    }
  }
  const capped = await makeRig({ mandate: { maxPerCallUsd: "0.02", dailyCeilingUsd: "0.02" } });
  Object.assign(process.env, hostile);
  try {
    capped.world.product("ok").priceMicro = 20_000;
    assert.equal((await capped.buy("ok")).outcome, "settled");
    assert.equal((await capped.buy("ok")).refusal.code, "budget_exceeded");
    assert.equal(capped.payer.signatures, 1);
  } finally {
    for (const key of Object.keys(hostile)) delete process.env[key];
    await capped.close();
  }
});

test("the decision ledger: one chained line per decision, tamper-evident, replayed on reopen", async () => {
  const rig = await makeRig();
  const file = path.join(rig.stateDir, STATE_FILES.decisionLedger);
  try {
    await rig.buy("ok");
    await rig.runtime.call({ tool: "http:evil.example", url: rig.world.url("ok") });
    rig.world.product("gratis").free = true;
    await rig.buy("gratis");
    const rows = rig.runtime.ledger.tail(10);
    // The pending line is written before the payment leaves; the settled line answers it by ref.
    assert.deepEqual(rows.map((r) => [r.seq, r.outcome, r.code, r.ref]), [
      [1, "pending", "payment_sent", null],
      [2, "settled", null, 1],
      [3, "refused", "tool_not_allowed", null],
      [4, "free", null, null],
    ]);
    assert.equal(rows[0].prev, "genesis");
    assert.equal(rows[1].target, rig.world.url("ok"));
    assert.deepEqual([rows[1].receipt, rows[1].inclusion, rows[1].signatures, rows[1].settledUsd], ["verified", "proven", 1, "0.01"]);
    assert.equal(verifyDecisionLedger(file).ok, true);
  } finally {
    await rig.close();
  }
  // Reopen: counters come back from the ledger, spend from the spend ledger.
  const again = await makeRig({ stateDir: rig.stateDir, agentKey: rig.agentKey });
  try {
    const status = again.runtime.status();
    assert.deepEqual([status.counters.decisions, status.counters.settled, status.counters.refusals, status.counters.signatures], [3, 1, 1, 1]);
    assert.equal(status.spend.dayUsd, "0.01");
    assert.equal(status.ledger.lines, 4);
  } finally {
    await again.close();
  }
  // Edit one line: the chain breaks, and a runtime refuses to extend it.
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines[2] = lines[2].replace('"refused"', '"settled"');
  fs.writeFileSync(file, lines.join("\n"));
  assert.equal(verifyDecisionLedger(file).ok, false);
  await assert.rejects(() => makeRig({ stateDir: rig.stateDir, agentKey: rig.agentKey }), /does not verify/);
});

test("a query string and credentials in the target never reach the ledger or the trust service", async () => {
  const rig = await makeRig();
  try {
    rig.world.product("gratis").free = true;
    const result = await rig.runtime.call({ tool: rig.tool, url: `${rig.world.url("gratis")}?api_key=SECRET#frag` });
    assert.equal(result.outcome, "free");
    assert.equal(fs.readFileSync(path.join(rig.stateDir, STATE_FILES.decisionLedger), "utf8").includes("SECRET"), false);
  } finally {
    await rig.close();
  }
});

test("one runtime per state directory", async () => {
  const rig = await makeRig();
  try {
    await assert.rejects(() => makeRig({ stateDir: rig.stateDir, agentKey: rig.agentKey }), /already open/);
    // A lock left by a process that is gone is cleared.
  } finally {
    await rig.close();
  }
  fs.writeFileSync(path.join(rig.stateDir, STATE_FILES.lock), "999999999\n");
  const again = await makeRig({ stateDir: rig.stateDir, agentKey: rig.agentKey });
  await again.close();
  assert.equal(fs.existsSync(path.join(rig.stateDir, STATE_FILES.lock)), false);
  // A lock held by a live process is honoured.
  fs.writeFileSync(path.join(rig.stateDir, STATE_FILES.lock), `${process.ppid}\n`);
  await assert.rejects(() => makeRig({ stateDir: rig.stateDir, agentKey: rig.agentKey }), /in use by process/);
});

test("the runtime refuses an agent key that is not the mandate's agent", async () => {
  const rig = await makeRig();
  await rig.close();
  const other = await makeRig();
  await other.close();
  assert.throws(
    () => createMandateRuntime({ mandate: rig.mandate, expiresAtMs: rig.expiresAtMs, stateDir: rig.stateDir, agentKey: other.agentKey }),
    /not the agent/,
  );
});

test("targets that are not http(s), and unreachable targets, are errors with no signature", async () => {
  const rig = await makeRig({ mandate: { allowedTools: ["http:127.0.0.1:9", "file"] } });
  try {
    const file = await rig.runtime.call({ tool: "file", url: "file:///etc/passwd" });
    assert.deepEqual([file.outcome, file.record.code, file.status], ["error", "bad_target", 400]);
    const dead = await rig.runtime.call({ tool: "http:127.0.0.1:9", url: "http://127.0.0.1:9/x" });
    assert.deepEqual([dead.outcome, dead.record.code, dead.status, dead.signatures], ["error", "upstream_error", 502, 0]);
  } finally {
    await rig.close();
  }
});
