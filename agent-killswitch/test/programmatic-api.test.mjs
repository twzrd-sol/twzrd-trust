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
    gate.estimate({ model: "demo", maxTokens: 1_000, promptBytes: 500, promptTextOnly: true }),
    { tokens: 1_500, usd: 0.0015 },
  );
  // Without a prompt size the dollar estimate is never below the per-request cap.
  assert.deepEqual(
    gate.estimate({ model: "demo", maxTokens: 1_000 }),
    { tokens: 1_000, usd: 0.04 },
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
    /maxTokens must be null, \+Infinity or a non-negative integer/,
  );
  assert.throws(
    () => gate.estimate({ model: "gpt-4o", maxTokens: Number.NaN }),
    /maxTokens must be null, \+Infinity or a non-negative integer/,
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

test("a window getter is bound to its first read, so NaN never reaches the math", () => {
  const gate = createBudgetGate(limits);
  let reads = 0;
  const window = { minuteTokens: 0, dayUsd: 0 };
  Object.defineProperty(window, "hourUsd", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? 0.08 : Number.NaN;
    },
  });

  const decision = gate.evaluate({ model: "gpt-4o", maxTokens: null, window });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "budget_exceeded");
  assert.equal(decision.spentUsd, 0.08);
  assert.ok(reads >= 1);
});

test("a getter that returns NaN on the first read throws instead of failing open", () => {
  const gate = createBudgetGate(limits);
  const window = { minuteTokens: 0, dayUsd: 0 };
  Object.defineProperty(window, "hourUsd", {
    enumerable: true,
    get() {
      return Number.NaN;
    },
  });

  assert.throws(
    () => gate.evaluate({ model: "gpt-4o", maxTokens: null, window }),
    /window\.hourUsd must be a finite non-negative number/,
  );
});

test("option and rate getters are bound to a single read as well", () => {
  let limitReads = 0;
  const options = { ...limits };
  Object.defineProperty(options, "maxTokensPerMinute", {
    enumerable: true,
    get() {
      limitReads += 1;
      return limitReads === 1 ? 100_000 : Number.NaN;
    },
  });
  assert.doesNotThrow(() => createBudgetGate(options));

  const badOptions = { ...limits };
  Object.defineProperty(badOptions, "maxTokensPerMinute", {
    enumerable: true,
    get() {
      return Number.NaN;
    },
  });
  assert.throws(() => createBudgetGate(badOptions), /maxTokensPerMinute must be a finite non-negative number/);

  const badRates = { demo: { inputPerMTok: 1 } };
  Object.defineProperty(badRates.demo, "outputPerMTok", {
    enumerable: true,
    get() {
      return Number.NaN;
    },
  });
  assert.throws(
    () => createBudgetGate({ ...limits, modelRates: badRates }),
    /modelRates\.demo\.outputPerMTok must be a finite non-negative number/,
  );
});

test("an empty allowedModels list throws instead of allowing every model", () => {
  assert.throws(
    () => createBudgetGate({ ...limits, allowedModels: [] }),
    /allowedModels must not be empty; pass null/,
  );
});

test("zeroPriceModels: [] opts a request out of free pricing without throwing", () => {
  const gate = createBudgetGate({ ...limits, zeroPriceModels: ["demo-free"] });

  // Default: demo-free is $0, so nothing is held against maxCostPerRequestUsd.
  const free = gate.estimate({ model: "demo-free", maxTokens: 1_000 });
  assert.equal(free.usd, 0);

  // A paid request (e.g. one carrying an x402 or MPP credential) passes [].
  const paid = gate.estimate({ model: "demo-free", maxTokens: 1_000, zeroPriceModels: [] });
  assert.ok(paid.usd > 0);
});

test("malformed booleans and pause strings throw instead of being coerced", () => {
  const gate = createBudgetGate(limits);
  const base = {
    model: "gpt-4o",
    maxTokens: null,
    window: { minuteTokens: 0, hourUsd: 0, dayUsd: 0 },
  };

  assert.throws(() => gate.evaluate({ ...base, killed: "yes" }), /killed must be a boolean/);
  assert.throws(() => gate.evaluate({ ...base, paused: 1 }), /paused must be a boolean/);
  assert.throws(() => gate.evaluate({ ...base, pauseReason: 42 }), /pauseReason must be a string or null/);
  assert.throws(
    () => gate.evaluate({ ...base, pauseDecisionId: {} }),
    /pauseDecisionId must be a string or null/,
  );
});
