import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetInputForChatRequest, createBudgetGate } from "@twzrd1111/agent-killswitch";
import { createAgentKillswitchHooks, refusalPayload } from "../budget-hook.ts";

/** Mock tool runner modelling Mastra's beforeToolCall/afterToolCall semantics. */
async function runToolCall(
  hooks: ReturnType<typeof createAgentKillswitchHooks>,
  call: { toolName: string; input: unknown },
  execute: () => Promise<unknown>,
) {
  const pre = hooks.beforeToolCall(call);
  if (pre && pre.proceed === false) {
    return { executed: false, output: pre.output };
  }
  let output: unknown;
  try {
    output = await execute();
  } catch (error) {
    hooks.afterToolCall({ ...call, error });
    return { executed: true, error };
  }
  hooks.afterToolCall({ ...call, output });
  return { executed: true, output };
}

const limits = {
  maxTokensPerMinute: 100_000,
  maxUsdPerHour: 0.01,
  maxUsdPerDay: 0.05,
  maxCostPerRequestUsd: 0.02,
};

function freshWindow(usd = 0) {
  return { minuteTokens: 0, hourUsd: usd, dayUsd: usd };
}

// A text-only request of 200 bytes asking for at most 100 output tokens.
const smallCall = () => ({ model: "gpt-4o", maxTokens: 100, promptBytes: 200, promptTextOnly: true });

test("allowed tool call executes and holds the estimate synchronously", async () => {
  const window = freshWindow();
  const hooks = createAgentKillswitchHooks({
    ...limits,
    window,
    estimate: smallCall,
  });
  const before = window.hourUsd;
  const { executed, output } = await runToolCall(hooks, { toolName: "search", input: { q: "x" } }, async () => ({ hits: 1 }));
  assert.equal(executed, true);
  assert.deepEqual(output, { hits: 1 });
  assert.ok(window.hourUsd > before); // hold landed before execute() finished
});

test("budget_exceeded veto blocks the tool and returns the refusal payload; tool never executes", async () => {
  // The hour is already over its cap: veto before execution.
  const window = freshWindow(0.0105);
  const hooks = createAgentKillswitchHooks({
    ...limits,
    window,
    estimate: smallCall,
  });
  let ran = false;
  const { executed, output } = await runToolCall(hooks, { toolName: "search", input: {} }, async () => {
    ran = true;
    return "executed";
  });
  assert.equal(executed, false);
  assert.equal(ran, false);
  assert.deepEqual(output, {
    error: {
      type: "killswitch_veto",
      code: "budget_exceeded",
      message: "Hourly limit $0.01 would be exceeded",
      spent_usd: 0.0105,
      limit_usd: 0.01,
    },
  });
});

test("with the hour and the day both spent, the daily refusal comes first", () => {
  const hooks = createAgentKillswitchHooks({
    ...limits,
    window: { minuteTokens: 0, hourUsd: 0.0105, dayUsd: 0.05 },
    estimate: smallCall,
  });
  const out = hooks.beforeToolCall({ toolName: "t", input: {} });
  assert.equal(out?.proceed, false);
  assert.equal((out?.output as any).error.message, "Daily limit $0.05 hit");
});

test("without a prompt size the hold is the per-request cap", async () => {
  const window = freshWindow();
  const roomy = { ...limits, maxUsdPerHour: 1, maxUsdPerDay: 1 };
  const hooks = createAgentKillswitchHooks({
    ...roomy,
    window,
    estimate: () => ({ model: "gpt-4o", maxTokens: 100 }),
  });
  const { executed } = await runToolCall(hooks, { toolName: "t", input: {} }, async () => "ok");
  assert.equal(executed, true);
  assert.equal(window.hourUsd, roomy.maxCostPerRequestUsd);

  // Under the test limits that cap does not fit in the hour, so the same call is refused.
  const tight = createAgentKillswitchHooks({
    ...limits,
    window: freshWindow(),
    estimate: () => ({ model: "gpt-4o", maxTokens: 100 }),
  });
  const out = tight.beforeToolCall({ toolName: "t", input: {} });
  assert.equal(out?.proceed, false);
  assert.equal((out?.output as any).error.code, "budget_exceeded");
});

test("budgetInputForChatRequest reads the estimate from the request text the tool sends", async () => {
  const text = JSON.stringify({
    model: "gpt-4o-mini",
    max_tokens: 200,
    messages: [{ role: "user", content: "Summarize the last three invoices." }],
  });
  const window = freshWindow();
  const hooks = createAgentKillswitchHooks({
    ...limits,
    window,
    estimate: () => budgetInputForChatRequest(text),
  });
  const { executed } = await runToolCall(hooks, { toolName: "summarize", input: {} }, async () => "ok");
  assert.equal(executed, true);
  const expected = createBudgetGate(limits).estimate(budgetInputForChatRequest(text));
  assert.ok(expected.usd < limits.maxCostPerRequestUsd); // the prompt size lowered the hold below the cap
  assert.equal(window.hourUsd, expected.usd);
  assert.equal(window.minuteTokens, expected.tokens);
});

test("veto output is deterministic for identical inputs", async () => {
  const mk = () => createAgentKillswitchHooks({ ...limits, window: freshWindow(0.0105), estimate: smallCall });
  const a = mk().beforeToolCall({ toolName: "t", input: {} });
  const b = mk().beforeToolCall({ toolName: "t", input: {} });
  assert.deepEqual(a, b);
});

test("holds are visible to the very next beforeToolCall in the same synchronous turn", async () => {
  // Room for one hold and a half: the first call fits, and the second call
  // must see the first call's hold and be refused.
  const call = { model: "demo", maxTokens: 10, promptBytes: 50, promptTextOnly: true };
  const hold = createBudgetGate(limits).estimate(call).usd;
  const spent = limits.maxUsdPerHour - 1.5 * hold;
  const window = { minuteTokens: 0, hourUsd: spent, dayUsd: spent };
  const hooks = createAgentKillswitchHooks({
    ...limits,
    window,
    estimate: () => call,
  });
  const first = hooks.beforeToolCall({ toolName: "t", input: {} });
  assert.equal(first, undefined); // allowed, hold now counts
  const second = hooks.beforeToolCall({ toolName: "t", input: {} });
  assert.equal(second?.proceed, false);
  assert.equal((second?.output as any).error.code, "budget_exceeded");
});

test("killed gate vetoes with kill_switch and never executes", async () => {
  const hooks = createAgentKillswitchHooks({
    ...limits,
    window: freshWindow(),
    estimate: smallCall,
    isKilled: () => true,
  });
  const out = hooks.beforeToolCall({ toolName: "t", input: {} });
  assert.equal(out?.proceed, false);
  assert.equal((out?.output as any).error.code, "kill_switch");
});

test("estimate throwing fails closed: the tool does not execute", async () => {
  const hooks = createAgentKillswitchHooks({
    ...limits,
    window: freshWindow(),
    estimate: () => {
      throw new Error("no estimate");
    },
  });
  assert.throws(() => hooks.beforeToolCall({ toolName: "t", input: {} }), /no estimate/);
});

test("afterToolCall replaces the hold with reported actuals", async () => {
  const window = freshWindow();
  const hooks = createAgentKillswitchHooks({
    ...limits,
    window,
    estimate: () => ({ model: "demo", maxTokens: 10, promptBytes: 50, promptTextOnly: true }),
    actualCost: () => ({ tokens: 5, usd: 0.0001 }),
  });
  await runToolCall(hooks, { toolName: "t", input: {} }, async () => "ok");
  assert.equal(window.minuteTokens, 5);
  assert.ok(Math.abs(window.hourUsd - 0.0001) < 1e-9);
});

test("refusalPayload is the OpenAI-shaped veto body", () => {
  const payload = refusalPayload({ code: "budget_exceeded", message: "m", spentUsd: 1.23456, limitUsd: 2, decisionId: "d" });
  assert.equal(payload.error.type, "killswitch_veto");
  assert.equal(payload.error.spent_usd, 1.2346);
  assert.equal(payload.error.decision_id, "d");
});

test("window is validated at construction (fail closed on garbage)", () => {
  assert.throws(
    () => createAgentKillswitchHooks({ ...limits, window: { minuteTokens: Number.NaN, hourUsd: 0, dayUsd: 0 }, estimate: smallCall }),
    /window\.minuteTokens/,
  );
});
