import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBudgetGate } from "@twzrd1111/agent-killswitch";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const limits = {
  maxTokensPerMinute: 100_000,
  maxUsdPerHour: 0.1,
  maxUsdPerDay: 0.1,
  maxCostPerRequestUsd: 0.04,
};

test("the package export ships both its ESM runtime and TypeScript declarations", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
  assert.equal(pkg.exports?.["."]?.import, "./dist/api.js");
  assert.equal(pkg.exports?.["."]?.types, "./dist/api.d.ts");
  assert.ok(fs.existsSync(path.join(pkgRoot, "dist", "api.js")));
  assert.ok(fs.existsSync(path.join(pkgRoot, "dist", "api.d.ts")));
});

test("createBudgetGate exposes the proxy's pure admission math without starting a server", () => {
  const gate = createBudgetGate(limits);
  const request = {
    model: "gpt-4o",
    maxTokens: null,
    window: { minuteTokens: 0, hourUsd: 0.05, dayUsd: 0.05 },
  };

  assert.deepEqual(gate.estimate(request), { tokens: 0, usd: 0.04 });
  assert.deepEqual(gate.evaluate(request), {
    allowed: true,
    status: 200,
    code: null,
    message: "allowed",
    spentUsd: 0,
    limitUsd: 0,
  });
});

test("createBudgetGate returns the same budget_exceeded contract as the proxy", () => {
  const gate = createBudgetGate(limits);
  const decision = gate.evaluate({
    model: "gpt-4o",
    maxTokens: null,
    window: { minuteTokens: 0, hourUsd: 0.078, dayUsd: 0.078 },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 429);
  assert.equal(decision.code, "budget_exceeded");
  assert.equal(decision.message, "Hourly limit $0.10 would be exceeded");
  assert.equal(decision.spentUsd, 0.078);
  assert.equal(decision.limitUsd, 0.1);
});

test("createBudgetGate snapshots limits and model rates at construction", () => {
  const modelRates = {
    demo: { inputPerMTok: 1, outputPerMTok: 1 },
  };
  const options = { ...limits, modelRates };
  const gate = createBudgetGate(options);

  options.maxUsdPerHour = 100;
  modelRates.demo.outputPerMTok = 1_000;

  const decision = gate.evaluate({
    model: "gpt-4o",
    maxTokens: null,
    window: { minuteTokens: 0, hourUsd: 0.078, dayUsd: 0.078 },
  });
  assert.equal(decision.code, "budget_exceeded");
  assert.deepEqual(
    gate.estimate({ model: "demo", maxTokens: 1_000 }),
    { tokens: 1_000, usd: 0.001 },
  );
});

test("createBudgetGate rejects malformed runtime requests instead of failing open", () => {
  const gate = createBudgetGate(limits);
  const base = {
    model: "gpt-4o",
    maxTokens: null,
    window: { minuteTokens: 0, hourUsd: 0, dayUsd: 0 },
  };

  assert.throws(
    () => gate.evaluate({ ...base, window: { ...base.window, hourUsd: Number.NaN } }),
    /window\.hourUsd must be a finite non-negative number/,
  );
  assert.throws(
    () => gate.evaluate({ ...base, window: { ...base.window, dayUsd: -1 } }),
    /window\.dayUsd must be a finite non-negative number/,
  );
  assert.throws(
    () => gate.evaluate({ ...base, maxTokens: 0.5 }),
    /maxTokens must be null or a finite non-negative integer/,
  );
  assert.throws(
    () => gate.estimate({ model: "gpt-4o", maxTokens: Number.NaN }),
    /maxTokens must be null or a finite non-negative integer/,
  );
  assert.throws(
    () => gate.evaluate({ ...base, model: "" }),
    /model must be a non-empty string/,
  );
});

test("createBudgetGate rejects malformed model-rate policy", () => {
  assert.throws(
    () =>
      createBudgetGate({
        ...limits,
        modelRates: { demo: { inputPerMTok: Number.NaN, outputPerMTok: 1 } },
      }),
    /modelRates\.demo\.inputPerMTok must be a finite non-negative number/,
  );
});
