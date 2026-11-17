// Stages 1-7 and the failure matrix. See lib.mjs for the stage list.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { ToolNotSentError, ToolRefusedError, ToolSettleError, TOOL_GUARD_PAUSE_REASON } from "../agent-killswitch/dist/api.js";
import { checkPauseSwitch } from "../agent-killswitch/dist/gate.js";
import {
  cleanEnv,
  createPipeline,
  createTestSigner,
  loopbackFetch,
  reconcile,
  RECEIPT_FIXTURE,
  SELLER,
  startWorld,
  tempState,
  verifyReceipt,
} from "./lib.mjs";

const LIMITS = { maxCostPerCallUsd: 0.02, maxUsdPerHour: 0.05, maxUsdPerDay: 0.05 };
const POLICY = { maxAmountUsd: "0.02", dailyCeilingUsd: "0.05" };
const notRoot = !(typeof process.getuid === "function" && process.getuid() === 0);
const near = (a, b) => Math.abs(a - b) < 1e-9;

let world;
let signer;
let net;
let state;

before(() => cleanEnv());
beforeEach(async () => {
  signer = createTestSigner();
  world = await startWorld(signer.publicKey);
  net = loopbackFetch();
  state = tempState();
});
afterEach(async () => {
  await world.close();
  assert.deepEqual(net.strays, [], "no request may leave loopback");
  fs.rmSync(state.dir, { recursive: true, force: true });
});
after(() => cleanEnv());

function pipeline(overrides = {}) {
  return createPipeline({ state, world, signer, limits: LIMITS, policy: POLICY, fetchImpl: net.fetch, ...overrides });
}

// ---- stages ----------------------------------------------------------------

test("stages 1-7: one paid call passes every control and all three records agree", async () => {
  const p = pipeline();
  const { result, settlement, trace } = await p.buy({ requestId: "happy-1" });
  assert.deepEqual(trace, ["agent", "tool_guard", "trust_gate", "budget", "payment", "receipt_verified"]);
  assert.equal(result.answer, 42);
  assert.equal(result.approval.approved, true);
  assert.deepEqual(result.receipt, { ok: true, bindingOk: true, referenceOk: true, subjectMatches: true });
  assert.deepEqual(settlement, { costUsd: 0.01, metered: "usage", tripped: false, tripReason: null });
  assert.equal(signer.signs, 1);
  assert.equal(world.paidCount, 1);
  assert.deepEqual(world.hits, ["challenge", "preflight", "merchant_card", "challenge", "merchant_card", "payment"]);

  const r = reconcile({ state, world, guard: p.guard });
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.toolMicro, 10_000);
  assert.equal(r.gateMicro, 10_000);
  assert.equal(r.sellerMicro, 10_000);
  assert.equal(fs.existsSync(state.pauseFile), false);
});

test("stage 2: a quote over the per-call cap is refused before the trust gate is asked", async () => {
  world.priceMicro = 30_000;
  const p = pipeline();
  await assert.rejects(p.buy(), (err) => err instanceof ToolRefusedError && err.code === "per_request_cap");
  assert.deepEqual(world.hits, ["challenge"], "only the agent's free quote reached the seller");
  assert.equal(signer.signs, 0);
});

test("stage 3: a seller the trust gate blocks is never paid and costs nothing", async () => {
  world.decision = "block";
  const p = pipeline();
  await assert.rejects(p.buy(), (err) => err instanceof ToolNotSentError && /twzrd_decision_block/.test(err.message));
  assert.equal(signer.signs, 0);
  assert.equal(world.paidCount, 0);
  assert.equal(p.guard.spend().dayUsd, 0);
  assert.deepEqual(reconcile({ state, world, guard: p.guard }).mismatches, []);
});

test("stage 3: a wash-flagged seller is refused", async () => {
  world.washFlagged = true;
  const p = pipeline();
  await assert.rejects(p.buy(), (err) => err instanceof ToolNotSentError && /twzrd_wash_flagged/.test(err.message));
  assert.equal(signer.signs, 0);
});

test("stage 4: the tool ledger and the gate's spend ledger agree call by call, and the gate's ceiling refuses on its own ledger", async () => {
  // The guard's limits are loose here so the gate's daily ceiling is the control that refuses.
  const p = pipeline({ limits: { maxCostPerCallUsd: 0.02, maxUsdPerHour: 1, maxUsdPerDay: 1 }, policy: { dailyCeilingUsd: "0.025" } });
  for (let call = 1; call <= 2; call++) {
    await p.buy();
    const r = reconcile({ state, world, guard: p.guard });
    assert.deepEqual(r.mismatches, []);
    assert.equal(r.gateMicro, call * 10_000);
  }
  await assert.rejects(p.buy(), (err) => err instanceof ToolNotSentError && /POLICY_DAILY_CEILING/.test(err.message));
  assert.equal(signer.signs, 2, "the third payment was never signed");
  assert.equal(world.paidCount, 2);
  const r = reconcile({ state, world, guard: p.guard });
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.toolMicro, 20_000);
});

test("stage 4: a ceiling with no ledger to enforce it is refused when the pipeline is built", () => {
  assert.throws(() => pipeline({ gateLedger: false }), /ceiling is configured without a spend ledger/);
  assert.throws(() => pipeline({ gateLedger: false, policy: { monthlyCeilingUsd: "1" } }), /without a spend ledger/);
  pipeline({ gateLedger: false, policy: { maxAmountUsd: "0.02" } }); // a per-payment cap needs no ledger
  assert.equal(signer.signs, 0);
});

test("stage 6: a tampered receipt is rejected and the payment still reconciles", async () => {
  const tampered = structuredClone(RECEIPT_FIXTURE);
  tampered.preimage.score += 1;
  world.receipt = tampered;
  const p = pipeline();
  const { result, trace } = await p.buy();
  assert.equal(trace.at(-1), "receipt_rejected");
  assert.equal(result.receipt.ok, false);
  assert.equal(result.receipt.bindingOk, false);
  assert.equal(result.receipt.referenceOk, false);
  assert.deepEqual(reconcile({ state, world, guard: p.guard }).mismatches, [], "the money moved and is on record");
});

test("stage 6: a valid receipt about a different seller is rejected", () => {
  assert.equal(verifyReceipt(RECEIPT_FIXTURE, SELLER).ok, true);
  const other = verifyReceipt(RECEIPT_FIXTURE, "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk");
  assert.equal(other.ok, false);
  assert.equal(other.subjectMatches, false);
  assert.equal(verifyReceipt(undefined, SELLER).ok, false);
});

// ---- failure matrix --------------------------------------------------------

test("failure 1a: .kill written after the guard said yes stops the trust gate", async () => {
  const p = pipeline();
  world.hook = (event) => {
    if (event === "preflight") fs.writeFileSync(state.killFile, "stop\n");
  };
  await assert.rejects(p.buy(), (err) => err instanceof ToolNotSentError && /twzrd_kill_switch/.test(err.message));
  assert.equal(signer.signs, 0);
  assert.equal(world.paidCount, 0);
  assert.equal(p.guard.spend().dayUsd, 0, "the hold was released");
  await assert.rejects(p.buy(), (err) => err instanceof ToolRefusedError && err.code === "kill_switch");
});

test("failure 1b: .kill written after the trust gate approved stops the payment before the signer", async () => {
  const p = pipeline();
  let challenges = 0;
  world.hook = (event) => {
    // The first challenge is the agent's quote; the second is the paying fetch's.
    if (event === "challenge" && ++challenges === 2) fs.writeFileSync(state.killFile, "stop\n");
  };
  await assert.rejects(p.buy(), (err) => err instanceof ToolNotSentError && /twzrd_kill_switch/.test(err.message));
  assert.equal(signer.signs, 0);
  assert.equal(world.paidCount, 0);
  assert.deepEqual(reconcile({ state, world, guard: p.guard }).mismatches, []);
});

test("failure 2: a bill above the quote trips the guard, halts the gate and shows in reconciliation", async () => {
  world.billMicro = 15_000; // quoted 10_000
  const p = pipeline();
  const { settlement } = await p.buy();
  assert.equal(settlement.tripped, true);
  assert.equal(settlement.costUsd, 0.015);
  const pause = checkPauseSwitch(state.pauseFile);
  assert.equal(pause.paused, true);
  assert.equal(pause.reason, TOOL_GUARD_PAUSE_REASON);

  const hitsBefore = world.hits.length;
  const approval = await p.approve();
  assert.equal(approval.approved, false);
  assert.match(approval.reason, /^twzrd_payment_paused/);
  assert.equal(world.hits.length, hitsBefore, "the gate halts before it asks intel");
  await assert.rejects(p.buy(), (err) => err instanceof ToolRefusedError && err.code === "payment_gate_halt");
  assert.equal(signer.signs, 1);

  const r = reconcile({ state, world, guard: p.guard });
  assert.equal(r.ok, false);
  assert.ok(r.mismatches.includes("tool ledger 15000 != gate ledger 10000"), r.mismatches.join("; "));
});

test("failure 3: a call the gate refused releases its hold, so the budget is whole for the next call", async () => {
  const p = pipeline({ limits: { maxCostPerCallUsd: 0.01, maxUsdPerHour: 0.01, maxUsdPerDay: 0.01 } });
  world.decision = "block";
  await assert.rejects(p.buy(), ToolNotSentError);
  assert.equal(fs.existsSync(state.toolLedger), false, "a released hold writes no line");
  assert.equal(fs.existsSync(state.pauseFile), false);
  world.decision = "allow";
  const { settlement } = await p.buy(); // needs the whole budget
  assert.equal(settlement.costUsd, 0.01);
  assert.deepEqual(reconcile({ state, world, guard: p.guard }).mismatches, []);
});

test("failure 4: a paid call whose spend cannot be written pauses everything, keeps counting, and can be recorded later", async (t) => {
  if (!notRoot) return t.skip("root ignores file permissions");
  const p = pipeline();
  await p.buy(); // creates the tool ledger
  world.hook = (event) => {
    if (event === "payment") fs.chmodSync(state.toolLedger, 0o400);
  };
  let failure;
  try {
    await assert.rejects(p.buy(), (err) => {
      failure = err;
      return err instanceof ToolSettleError;
    });
  } finally {
    world.hook = () => {};
    fs.chmodSync(state.toolLedger, 0o600);
  }
  assert.equal(failure.result.answer, 42, "the result that was paid for is handed back");
  assert.equal(world.paidCount, 2, "the seller was paid");
  assert.equal(checkPauseSwitch(state.pauseFile).paused, true);
  assert.ok(near(p.guard.spend().dayUsd, 0.02), "the unrecorded bill still counts in the guard");
  const approval = await p.approve();
  assert.equal(approval.approved, false);
  assert.match(approval.reason, /^twzrd_payment_paused/);
  const before = reconcile({ state, world, guard: p.guard });
  assert.equal(before.ok, false, "reconciliation reports the spend the tool ledger is missing");
  assert.ok(before.mismatches.some((m) => m.startsWith("tool ledger 10000 != gate ledger 20000")), before.mismatches.join("; "));

  // The ledger is writable again: retry the write through the hold that came back.
  assert.equal(failure.hold.settle().costUsd, 0.01);
  assert.deepEqual(reconcile({ state, world, guard: p.guard }).mismatches, []);
});

test("failure 5: parallel calls cannot spend the same budget twice", async () => {
  const p = pipeline({
    limits: { maxCostPerCallUsd: 0.01, maxUsdPerHour: 0.03, maxUsdPerDay: 0.03 },
    policy: { dailyCeilingUsd: "0.03" },
  });
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => p.buy({ requestId: `race-${i}` })));
  const paid = results.filter((r) => r.status === "fulfilled");
  const refused = results.filter((r) => r.status === "rejected");
  assert.equal(paid.length, 3);
  assert.equal(refused.length, 5);
  for (const r of refused) {
    assert.ok(r.reason instanceof ToolRefusedError, String(r.reason));
    assert.equal(r.reason.code, "budget_exceeded");
  }
  assert.equal(signer.signs, 3);
  assert.equal(world.paidCount, 3);
  const r = reconcile({ state, world, guard: p.guard });
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.sellerMicro, 30_000);
});

test("failure 6a: a pause the trust gate writes stops the tool guard", async () => {
  const p = pipeline({ tripPauseOnBlockMs: 60_000 });
  world.decision = "block";
  let refusal;
  await assert.rejects(p.buy(), (err) => {
    refusal = err;
    return err instanceof ToolNotSentError;
  });
  const pause = checkPauseSwitch(state.pauseFile);
  assert.equal(pause.paused, true);
  assert.equal(pause.decisionId, refusal.cause.decisionId, "the pause names the gate decision that wrote it");
  world.decision = "allow";
  const hitsBefore = world.hits.filter((h) => h !== "challenge").length;
  await assert.rejects(p.buy(), (err) => err instanceof ToolRefusedError && err.code === "payment_gate_halt");
  assert.equal(world.hits.filter((h) => h !== "challenge").length, hitsBefore, "the guard refused before intel or payment");
  assert.equal(signer.signs, 0);
});

test("failure 6b: a pause the tool guard writes stops the payment gate", async () => {
  world.reportBill = false; // the seller reports no bill: the guard counts the worst case and trips
  const p = pipeline();
  const { settlement } = await p.buy();
  assert.equal(settlement.tripped, true);
  assert.equal(settlement.metered, "held_estimate");
  assert.equal(checkPauseSwitch(state.pauseFile).reason, TOOL_GUARD_PAUSE_REASON);
  const approval = await p.approve();
  assert.equal(approval.approved, false);
  assert.match(approval.reason, /^twzrd_payment_paused/);
  // The paying path refuses on its own too, without the approval step in front of it.
  await assert.rejects(p.buy(), (err) => err instanceof ToolRefusedError && err.code === "payment_gate_halt");
  assert.equal(signer.signs, 1);
});
