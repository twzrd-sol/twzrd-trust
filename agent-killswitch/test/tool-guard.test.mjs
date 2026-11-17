import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createToolGuard,
  ToolNotSentError,
  ToolRefusedError,
  TOOL_GUARD_PAUSE_REASON,
} from "@twzrd1111/agent-killswitch";
import { Ledger } from "../dist/ledger.js";
import { verifyLedgerFile } from "../dist/chain.js";
import { checkPauseSwitch, writePauseSwitch } from "../dist/gate.js";

function state() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-tool-guard-"));
  return {
    dir,
    ledgerPath: path.join(dir, "ledger.jsonl"),
    killFilePath: path.join(dir, ".kill"),
    pauseFilePath: path.join(dir, ".pause"),
  };
}

function guardFor(s, overrides = {}) {
  return createToolGuard({
    ledgerPath: s.ledgerPath,
    killFilePath: s.killFilePath,
    pauseFilePath: s.pauseFilePath,
    allowedTools: ["search", "news"],
    maxCostPerCallUsd: 0.002,
    maxUsdPerHour: 0.05,
    maxUsdPerDay: 0.05,
    ...overrides,
  });
}

function lines(s) {
  if (!fs.existsSync(s.ledgerPath)) return [];
  return fs.readFileSync(s.ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("an allowed call holds its worst case, then records the bill on the chained ledger", () => {
  const s = state();
  const guard = guardFor(s);
  const decision = guard.authorize({ tool: "search", worstCaseUsd: 0.001, requestId: "r1" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, null);
  assert.equal(guard.spend().hourUsd, 0.001, "the hold counts before anything is written");
  assert.deepEqual(lines(s), []);

  const settlement = decision.hold.settle(0.0005);
  assert.deepEqual(settlement, { costUsd: 0.0005, metered: "usage", tripped: false, tripReason: null });
  assert.equal(guard.spend().hourUsd, 0.0005);

  const [row] = lines(s);
  assert.equal(row.model, "(tool)");
  assert.equal(row.allowed, true);
  assert.equal(row.cost_usd, 0.0005);
  assert.equal(row.request_id, "r1");
  assert.equal(row.metered, "usage");
  assert.deepEqual(row.tool, { name: "search", event: "settled", worst_case_usd: 0.001, billed_usd: 0.0005 });
  assert.equal(row.prev, "genesis");
  assert.equal(verifyLedgerFile(s.ledgerPath, { strict: true }).ok, true);
  assert.equal(fs.existsSync(s.pauseFilePath), false);
});

test("a tool that is not on the allow-list is refused and nothing is held", () => {
  const s = state();
  const guard = guardFor(s);
  const decision = guard.authorize({ tool: "crunchbase", worstCaseUsd: 0.001 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "tool_not_allowed");
  assert.equal(decision.hold, null);
  assert.equal(guard.spend().dayUsd, 0);
  const [row] = lines(s);
  assert.equal(row.allowed, false);
  assert.equal(row.veto_reason, "tool_not_allowed");
  assert.equal(row.cost_usd, 0);
  assert.equal(row.tool.event, "refused");
});

test("a call whose cost cannot be bounded is refused", () => {
  const s = state();
  const guard = guardFor(s);
  for (const worstCaseUsd of [null, undefined, Number.POSITIVE_INFINITY, Number.NaN, -0.001, "0.001"]) {
    const decision = guard.authorize({ tool: "search", worstCaseUsd });
    assert.equal(decision.code, "unbounded_cost", String(worstCaseUsd));
    assert.equal(decision.hold, null);
  }
  assert.equal(guard.spend().dayUsd, 0);
});

test("a worst case over the per-call cap is refused; one that exactly fills it passes", () => {
  const s = state();
  const guard = guardFor(s, { maxCostPerCallUsd: 0.0055 });
  assert.equal(guard.authorize({ tool: "search", worstCaseUsd: 0.0056 }).code, "per_request_cap");
  // 0.0005 + 10 * 0.0005 is not exactly 0.0055 in binary.
  let worst = 0.0005;
  for (let i = 0; i < 10; i += 1) worst += 0.0005;
  const ok = guard.authorize({ tool: "search", worstCaseUsd: worst });
  assert.equal(ok.allowed, true);
  ok.hold.release();
});

test("parallel calls cannot pass on the same unheld budget", () => {
  const s = state();
  const guard = guardFor(s, { maxUsdPerHour: 0.003, maxUsdPerDay: 0.003 });
  const a = guard.authorize({ tool: "search", worstCaseUsd: 0.002 });
  const b = guard.authorize({ tool: "news", worstCaseUsd: 0.002 });
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, false);
  assert.equal(b.code, "budget_exceeded");
  // A released hold frees the budget again and writes no spend.
  a.hold.release();
  const c = guard.authorize({ tool: "news", worstCaseUsd: 0.002 });
  assert.equal(c.allowed, true);
  c.hold.release();
  assert.equal(guard.spend().dayUsd, 0);
});

test("the daily limit is enforced separately from the hourly one", () => {
  const s = state();
  const guard = guardFor(s, { maxUsdPerHour: 1, maxUsdPerDay: 0.001 });
  const decision = guard.authorize({ tool: "search", worstCaseUsd: 0.002 });
  assert.equal(decision.code, "budget_exceeded");
  assert.match(decision.message, /daily limit/);
});

test("inference spend on a shared ledger counts against the tool budget", () => {
  const s = state();
  const proxyLedger = new Ledger(s.ledgerPath);
  proxyLedger.append({
    timestamp: new Date().toISOString(),
    model: "gpt-4o",
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20,
    cost_usd: 0.049,
    allowed: true,
    veto_reason: null,
    request_id: "chat-1",
  });
  const guard = guardFor(s);
  assert.equal(guard.spend().hourUsd, 0.049);
  assert.equal(guard.authorize({ tool: "search", worstCaseUsd: 0.002 }).code, "budget_exceeded");
  const ok = guard.authorize({ tool: "search", worstCaseUsd: 0.001 });
  assert.equal(ok.allowed, true);
  ok.hold.settle(0.001);
  // A second reader of the same file (the proxy) sees the tool spend.
  assert.ok(Math.abs(new Ledger(s.ledgerPath).window().dayUsd - 0.05) < 1e-12);
  assert.equal(verifyLedgerFile(s.ledgerPath, { strict: true }).ok, true);
});

test("the kill file refuses every tool call", () => {
  const s = state();
  const guard = guardFor(s);
  fs.writeFileSync(s.killFilePath, "now\n");
  const decision = guard.authorize({ tool: "search", worstCaseUsd: 0.001 });
  assert.equal(decision.code, "kill_switch");
  assert.equal(decision.hold, null);
  fs.rmSync(s.killFilePath);
  const ok = guard.authorize({ tool: "search", worstCaseUsd: 0.001 });
  assert.equal(ok.allowed, true);
  ok.hold.release();
});

test("a pause written by another component refuses tool calls", () => {
  const s = state();
  const guard = guardFor(s);
  writePauseSwitch(s.pauseFilePath, { ttlMs: 60_000, reason: "budget_exceeded" });
  const decision = guard.authorize({ tool: "search", worstCaseUsd: 0.001 });
  assert.equal(decision.code, "payment_gate_halt");
  assert.match(decision.message, /budget_exceeded/);
  // A corrupt sentinel fails closed too.
  fs.writeFileSync(s.pauseFilePath, "not json");
  assert.equal(guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).code, "payment_gate_halt");
});

test("a bill above the worst case is recorded in full and trips the guard", () => {
  const s = state();
  const guard = guardFor(s);
  const before = Date.now();
  const settlement = guard.authorize({ tool: "search", worstCaseUsd: 0.001, requestId: "r9" }).hold.settle(0.004);
  assert.equal(settlement.costUsd, 0.004);
  assert.equal(settlement.tripped, true);
  assert.match(settlement.tripReason, /billed \$0\.004, over its worst case \$0\.001/);

  const pause = checkPauseSwitch(s.pauseFilePath);
  assert.equal(pause.paused, true);
  assert.equal(pause.reason, TOOL_GUARD_PAUSE_REASON);
  assert.equal(pause.decisionId, "r9");
  assert.ok(pause.untilUnixMs >= before + 3_600_000 && pause.untilUnixMs <= Date.now() + 3_600_000);

  const rows = lines(s);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tool.event, "settled");
  assert.equal(rows[0].cost_usd, 0.004);
  assert.equal(rows[1].tool.event, "trip");
  assert.equal(rows[1].allowed, false);
  assert.equal(rows[1].cost_usd, 0);
  assert.equal(rows[1].veto_reason, TOOL_GUARD_PAUSE_REASON);
  assert.equal(rows[1].tool.pause_until_unix_ms, pause.untilUnixMs);

  const next = guard.authorize({ tool: "search", worstCaseUsd: 0.001 });
  assert.equal(next.code, "payment_gate_halt");
  assert.match(next.message, new RegExp(TOOL_GUARD_PAUSE_REASON));
  assert.equal(guard.spend().dayUsd, 0.004, "the trip line and the refusal add no spend");
  assert.equal(verifyLedgerFile(s.ledgerPath, { strict: true }).ok, true);
});

test("a bill equal to the worst case does not trip", () => {
  const s = state();
  const guard = guardFor(s);
  const settlement = guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold.settle(0.001);
  assert.equal(settlement.tripped, false);
  assert.equal(fs.existsSync(s.pauseFilePath), false);
});

test("a call with no readable bill records the worst case and trips", () => {
  for (const bill of [null, undefined, Number.NaN, -1, "0.001"]) {
    const s = state();
    const guard = guardFor(s);
    const settlement = guard.authorize({ tool: "news", worstCaseUsd: 0.0015 }).hold.settle(bill);
    assert.deepEqual(
      { costUsd: settlement.costUsd, metered: settlement.metered, tripped: settlement.tripped },
      { costUsd: 0.0015, metered: "held_estimate", tripped: true },
      String(bill),
    );
    assert.equal(lines(s)[0].tool.billed_usd, null);
    assert.equal(checkPauseSwitch(s.pauseFilePath).paused, true);
  }
});

test("a trip never shortens a longer pause", () => {
  const s = state();
  const guard = guardFor(s, { tripPauseMs: 1_000 });
  const hold = guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold;
  writePauseSwitch(s.pauseFilePath, { ttlMs: 7_200_000, reason: "budget_exceeded" });
  const longer = checkPauseSwitch(s.pauseFilePath).untilUnixMs;
  assert.equal(hold.settle(null).tripped, true);
  const pause = checkPauseSwitch(s.pauseFilePath);
  assert.equal(pause.untilUnixMs, longer);
  assert.equal(pause.reason, "budget_exceeded");
  assert.equal(lines(s).at(-1).tool.pause_until_unix_ms, null);
});

test("a trip whose .pause cannot be written is held in memory", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root ignores directory permissions");
    return;
  }
  const s = state();
  const locked = path.join(s.dir, "locked");
  fs.mkdirSync(locked);
  const guard = guardFor(s, { pauseFilePath: path.join(locked, ".pause") });
  const hold = guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold;
  // The sentinel reads as absent, and its directory refuses the write.
  fs.chmodSync(locked, 0o500);
  try {
    assert.equal(hold.settle(null).tripped, true);
    assert.equal(fs.existsSync(path.join(locked, ".pause")), false);
    const trip = lines(s).at(-1);
    assert.equal(trip.tool.pause_write_failed, true);
    const next = guard.authorize({ tool: "search", worstCaseUsd: 0.001 });
    assert.equal(next.allowed, false);
    assert.equal(next.code, "payment_gate_halt");
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("a hold settles or releases exactly once", () => {
  const s = state();
  const guard = guardFor(s);
  const a = guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold;
  a.settle(0.001);
  assert.throws(() => a.settle(0.001), /already settled or released/);
  assert.throws(() => a.release(), /already settled or released/);
  const b = guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold;
  b.release();
  assert.throws(() => b.settle(0.001), /already settled or released/);
  assert.equal(lines(s).length, 1);
});

test("run() settles the bill and returns the result", async () => {
  const s = state();
  const guard = guardFor(s);
  const out = await guard.run({ tool: "search", worstCaseUsd: 0.001 }, async () => ({
    result: { hits: 3 },
    billedUsd: 0.0005,
  }));
  assert.deepEqual(out.result, { hits: 3 });
  assert.equal(out.settlement.costUsd, 0.0005);
  assert.equal(out.settlement.tripped, false);
});

test("run() never calls the tool when the guard refuses", async () => {
  const s = state();
  const guard = guardFor(s);
  let called = 0;
  await assert.rejects(
    guard.run({ tool: "crunchbase", worstCaseUsd: 0.001 }, async () => {
      called += 1;
      return { result: null, billedUsd: 0 };
    }),
    (err) => err instanceof ToolRefusedError && err.code === "tool_not_allowed" && err.decision.hold === null,
  );
  assert.equal(called, 0);
  assert.equal(guard.spend().dayUsd, 0);
});

test("run() counts the worst case and trips when the tool throws or returns no bill", async () => {
  const s = state();
  const guard = guardFor(s);
  await assert.rejects(
    guard.run({ tool: "search", worstCaseUsd: 0.002 }, async () => {
      throw new Error("socket hang up");
    }),
    /socket hang up/,
  );
  assert.equal(guard.spend().dayUsd, 0.002);
  assert.equal(checkPauseSwitch(s.pauseFilePath).paused, true);

  const s2 = state();
  const guard2 = guardFor(s2);
  const out = await guard2.run({ tool: "search", worstCaseUsd: 0.002 }, async () => ({ result: "ok" }));
  assert.equal(out.settlement.tripped, true);
  assert.equal(out.settlement.metered, "held_estimate");

  const s3 = state();
  const guard3 = guardFor(s3);
  await assert.rejects(guard3.run({ tool: "search", worstCaseUsd: 0.002 }, async () => undefined), TypeError);
  assert.equal(guard3.spend().dayUsd, 0.002);
});

test("options are validated and snapshotted", () => {
  const s = state();
  assert.throws(() => guardFor(s, { allowedTools: [] }), /non-empty array/);
  assert.throws(() => guardFor(s, { allowedTools: null }), /non-empty array/);
  assert.throws(() => guardFor(s, { allowedTools: ["search", " "] }), /allowedTools\[1\]/);
  assert.throws(() => guardFor(s, { maxUsdPerDay: Number.POSITIVE_INFINITY }), /maxUsdPerDay/);
  assert.throws(() => guardFor(s, { maxCostPerCallUsd: -1 }), /maxCostPerCallUsd/);
  assert.throws(() => guardFor(s, { ledgerPath: "" }), /ledgerPath/);
  assert.throws(() => guardFor(s, { tripPauseMs: 0 }), /tripPauseMs/);
  assert.throws(() => guardFor(s, { tripPauseMs: 86_400_001 }), /tripPauseMs/);
  assert.throws(() => createToolGuard(null), /options must be an object/);

  const allowedTools = ["search"];
  const options = {
    ledgerPath: s.ledgerPath,
    killFilePath: s.killFilePath,
    pauseFilePath: s.pauseFilePath,
    allowedTools,
    maxCostPerCallUsd: 0.002,
    maxUsdPerHour: 0.05,
    maxUsdPerDay: 0.05,
  };
  const guard = createToolGuard(options);
  allowedTools.push("crunchbase");
  options.maxCostPerCallUsd = 100;
  assert.equal(guard.authorize({ tool: "crunchbase", worstCaseUsd: 0.001 }).code, "tool_not_allowed");
  assert.equal(guard.authorize({ tool: "search", worstCaseUsd: 1 }).code, "per_request_cap");
  assert.throws(() => guard.authorize({ tool: "", worstCaseUsd: 0.001 }), /tool must be a non-empty string/);
  assert.throws(() => guard.authorize({ tool: "search", worstCaseUsd: 0.001, requestId: 7 }), /requestId/);
});

// --- Cases added after the independent review of the first version. ---

const notRoot = !(typeof process.getuid === "function" && process.getuid() === 0);

test("a bill that cannot be recorded still pauses and keeps counting", (t) => {
  if (!notRoot) return t.skip("root ignores file permissions");
  const s = state();
  const guard = guardFor(s);
  guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold.settle(0.001); // creates the ledger
  const hold = guard.authorize({ tool: "search", worstCaseUsd: 0.001, requestId: "r2" }).hold;
  fs.chmodSync(s.ledgerPath, 0o400);
  try {
    assert.throws(() => hold.settle(0.03), /EACCES/);
    const pause = checkPauseSwitch(s.pauseFilePath);
    assert.equal(pause.paused, true, "the over-bill pauses even though the ledger refused the line");
    assert.equal(pause.reason, TOOL_GUARD_PAUSE_REASON);
    assert.ok(Math.abs(guard.spend().dayUsd - 0.031) < 1e-12, "the full bill counts in memory");
  } finally {
    fs.chmodSync(s.ledgerPath, 0o600);
  }
  // Deleting .pause does not resume this guard: it also holds the pause in memory.
  fs.rmSync(s.pauseFilePath);
  assert.equal(guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).code, "payment_gate_halt");
  // The hold stayed open, so the write can be retried once the ledger is writable.
  const settlement = hold.settle(0.03);
  assert.equal(settlement.costUsd, 0.03);
  assert.equal(settlement.tripped, true);
  assert.ok(Math.abs(new Ledger(s.ledgerPath).window().dayUsd - 0.031) < 1e-12);
});

test("run() rethrows the tool's own error when the ledger cannot be written", async (t) => {
  if (!notRoot) return t.skip("root ignores file permissions");
  const s = state();
  const guard = guardFor(s);
  guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold.settle(0.001);
  await assert.rejects(
    guard.run({ tool: "search", worstCaseUsd: 0.002 }, async () => {
      fs.chmodSync(s.ledgerPath, 0o400);
      throw new Error("ORIGINAL");
    }),
    /ORIGINAL/,
  );
  fs.chmodSync(s.ledgerPath, 0o600);
  assert.equal(checkPauseSwitch(s.pauseFilePath).paused, true);
  assert.ok(Math.abs(guard.spend().dayUsd - 0.003) < 1e-12);
});

test("run() treats a bill that throws when read as no bill", async () => {
  const s = state();
  const guard = guardFor(s);
  await assert.rejects(
    guard.run({ tool: "search", worstCaseUsd: 0.002 }, async () => ({
      result: 1,
      get billedUsd() {
        throw new Error("getter");
      },
    })),
    /getter/,
  );
  const rows = lines(s);
  assert.equal(rows[0].cost_usd, 0.002);
  assert.equal(rows[0].metered, "held_estimate");
  assert.equal(rows[1].tool.event, "trip");
  assert.equal(checkPauseSwitch(s.pauseFilePath).paused, true);
});

test("run() releases the hold when the tool says the call was never sent", async () => {
  const s = state();
  const guard = guardFor(s);
  await assert.rejects(
    guard.run({ tool: "search", worstCaseUsd: 0.002 }, async () => {
      throw new ToolNotSentError("ENOTFOUND");
    }),
    (err) => err instanceof ToolNotSentError && err.message === "ENOTFOUND",
  );
  assert.equal(guard.spend().dayUsd, 0);
  assert.deepEqual(lines(s), []);
  assert.equal(fs.existsSync(s.pauseFilePath), false);
  const ok = guard.authorize({ tool: "search", worstCaseUsd: 0.002 });
  assert.equal(ok.allowed, true);
  ok.hold.release();
});

test("two guards on one ledger file see each other's holds", () => {
  const s = state();
  const a = guardFor(s, { maxUsdPerHour: 0.003, maxUsdPerDay: 0.003 });
  // A different spelling of the same path is the same file.
  const b = guardFor(s, { maxUsdPerHour: 0.003, maxUsdPerDay: 0.003, ledgerPath: path.join(s.dir, ".", "ledger.jsonl") });
  const first = a.authorize({ tool: "search", worstCaseUsd: 0.002 });
  assert.equal(first.allowed, true);
  assert.equal(b.spend().hourUsd, 0.002);
  assert.equal(b.authorize({ tool: "search", worstCaseUsd: 0.002 }).code, "budget_exceeded");
  first.hold.release();
});

test("an open hold counts for as long as it is open", (t) => {
  const s = state();
  const guard = guardFor(s, { maxUsdPerHour: 0.003, maxUsdPerDay: 0.003 });
  const slow = guard.authorize({ tool: "search", worstCaseUsd: 0.002 });
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 25 * 3600 * 1000;
  assert.equal(guard.spend().hourUsd, 0.002);
  assert.equal(guard.authorize({ tool: "search", worstCaseUsd: 0.002 }).code, "budget_exceeded");
  Date.now = realNow;
  slow.hold.release();
});

test("ledger spend that is not a non-negative number refuses instead of passing", () => {
  for (const cost of ["x", {}, -100, null]) {
    const s = state();
    const base = { model: "gpt-4o", prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, allowed: true, veto_reason: null, request_id: null };
    fs.writeFileSync(
      s.ledgerPath,
      JSON.stringify({ ...base, timestamp: new Date().toISOString(), cost_usd: 10 }) + "\n" +
        JSON.stringify({ ...base, timestamp: new Date().toISOString(), cost_usd: cost }) + "\n",
    );
    const guard = guardFor(s);
    const decision = guard.authorize({ tool: "search", worstCaseUsd: 0.001 });
    assert.equal(decision.allowed, false, JSON.stringify(cost));
    assert.equal(decision.code, "budget_exceeded");
  }
});

test("tripPauseMs must be a whole number of at least one second", () => {
  const s = state();
  for (const tripPauseMs of [0.5, 999, 1000.5, Number.NaN, "60000"]) {
    assert.throws(() => guardFor(s, { tripPauseMs }), /tripPauseMs/, String(tripPauseMs));
  }
  guardFor(s, { tripPauseMs: 1000 });
});

test("the kill file is reported ahead of a pause", () => {
  const s = state();
  const guard = guardFor(s);
  writePauseSwitch(s.pauseFilePath, { ttlMs: 60_000, reason: "budget_exceeded" });
  fs.writeFileSync(s.killFilePath, "now\n");
  assert.equal(guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).code, "kill_switch");
});

test("a bill inside the rounding slack above the worst case does not trip", () => {
  const s = state();
  const guard = guardFor(s);
  let billed = 0.0001;
  for (let i = 0; i < 9; i += 1) billed += 0.0001; // 0.0009999999999999999 or a hair over 0.001
  assert.equal(guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold.settle(0.001 + 5e-10).tripped, false);
  assert.equal(guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold.settle(billed).tripped, false);
  assert.equal(guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold.settle(0.001 + 1e-8).tripped, true);
});

test("a trip replaces an expired sentinel and leaves a corrupt one alone", () => {
  const s = state();
  const guard = guardFor(s);
  const hold = guard.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold;
  writePauseSwitch(s.pauseFilePath, { ttlMs: 1, reason: "budget_exceeded", now: Date.now() - 10_000 });
  assert.equal(checkPauseSwitch(s.pauseFilePath).expired, true);
  hold.settle(null);
  const pause = checkPauseSwitch(s.pauseFilePath);
  assert.equal(pause.paused, true);
  assert.equal(pause.reason, TOOL_GUARD_PAUSE_REASON);

  const s2 = state();
  const guard2 = guardFor(s2);
  const hold2 = guard2.authorize({ tool: "search", worstCaseUsd: 0.001 }).hold;
  fs.writeFileSync(s2.pauseFilePath, "not json");
  assert.equal(hold2.settle(null).tripped, true);
  assert.equal(fs.readFileSync(s2.pauseFilePath, "utf8"), "not json");
  assert.equal(lines(s2).at(-1).tool.pause_until_unix_ms, null);
  assert.equal(guard2.authorize({ tool: "search", worstCaseUsd: 0.001 }).code, "payment_gate_halt");
});

test("run() settles and trips when the tool function throws synchronously", async () => {
  const s = state();
  const guard = guardFor(s);
  await assert.rejects(
    guard.run({ tool: "search", worstCaseUsd: 0.002 }, () => {
      throw new Error("sync");
    }),
    /sync/,
  );
  assert.equal(guard.spend().dayUsd, 0.002);
  assert.equal(checkPauseSwitch(s.pauseFilePath).paused, true);
});

test("isNotSent releases the hold only when it returns exactly true", async () => {
  const s = state();
  const guard = guardFor(s);
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  const seen = [];
  await assert.rejects(
    guard.run({ tool: "search", worstCaseUsd: 0.002 }, async () => { throw dns; }, {
      isNotSent: (err) => { seen.push(err); return err.code === "ENOTFOUND"; },
    }),
    (err) => err === dns,
  );
  assert.deepEqual(seen, [dns]);
  assert.equal(guard.spend().dayUsd, 0);
  assert.deepEqual(lines(s), []);
  assert.equal(fs.existsSync(s.pauseFilePath), false);
});

test("an unclassified error, a truthy non-true answer and a throwing classifier all fail closed", async () => {
  const cases = [
    { name: "returns false", isNotSent: () => false },
    { name: "returns a truthy string", isNotSent: () => "yes" },
    { name: "returns 1", isNotSent: () => 1 },
    { name: "throws", isNotSent: () => { throw new Error("classifier"); } },
    { name: "absent", isNotSent: undefined },
  ];
  for (const c of cases) {
    const s = state();
    const guard = guardFor(s);
    await assert.rejects(
      guard.run({ tool: "search", worstCaseUsd: 0.002 }, async () => { throw new Error("ECONNRESET"); },
        c.isNotSent ? { isNotSent: c.isNotSent } : undefined),
      /ECONNRESET/,
      c.name,
    );
    assert.equal(guard.spend().dayUsd, 0.002, c.name);
    assert.equal(checkPauseSwitch(s.pauseFilePath).paused, true, c.name);
    assert.equal(lines(s).at(-1).tool.event, "trip", c.name);
  }
});

test("isNotSent is not consulted on success and must be a function", async () => {
  const s = state();
  const guard = guardFor(s);
  let asked = 0;
  const out = await guard.run({ tool: "search", worstCaseUsd: 0.001 }, async () => ({ result: 1, billedUsd: 0.001 }), {
    isNotSent: () => { asked += 1; return true; },
  });
  assert.equal(out.settlement.costUsd, 0.001);
  assert.equal(asked, 0);
  let called = 0;
  for (const bad of [{ isNotSent: "ENOTFOUND" }, null, []]) {
    await assert.rejects(
      guard.run({ tool: "search", worstCaseUsd: 0.001 }, async () => { called += 1; return { result: 1, billedUsd: 0 }; }, bad),
      TypeError,
    );
  }
  assert.equal(called, 0, "a bad options object is rejected before anything is held or sent");
  assert.equal(guard.spend().dayUsd, 0.001);
});
