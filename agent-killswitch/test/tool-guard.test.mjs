import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createToolGuard,
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
