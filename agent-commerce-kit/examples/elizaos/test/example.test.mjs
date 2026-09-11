import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCommercePlugin } from "../plugin.mjs";
import { summarizeMetrics } from "../metrics.mjs";

async function run(activity = "external") {
  const metrics = [];
  const plugin = createAgentCommercePlugin({ offline: true, activity, metricSink: event => metrics.push(event) });
  const result = await plugin.actions[0].handler({}, { content: {} }, undefined, { runId: `test-${activity}` });
  return { result: result.data, metrics };
}

test("ElizaOS action runs block and verified allow journeys end-to-end", async () => {
  const { result, metrics } = await run();
  assert.equal(result.discovered, 2);
  const unsafe = result.journeys.find(item => item.merchant.expected === "block");
  const safe = result.journeys.find(item => item.merchant.expected === "pass");
  assert.equal(unsafe.preflight.decision, "block");
  assert.equal(unsafe.signer_invocations, 0);
  assert.equal(unsafe.evidence.outcome.payment, "blocked");
  assert.equal(safe.preflight.decision, "allow");
  assert.equal(safe.signer_invocations, 1);
  assert.equal(safe.evidence.outcome.payment, "settled");
  assert.equal(safe.evidence.outcome.delivery, "delivered");
  assert.equal(safe.evidence.outcome.attribution, "verified");
  assert.deepEqual(summarizeMetrics(metrics), { "external:kit_install": 1, "external:preflight_call": 2, "external:simulator_run": 2, "external:verified_journey": 1 });
});

test("house activity cannot be conflated with external activity", async () => {
  const external = await run("external"); const house = await run("house");
  const summary = summarizeMetrics([...external.metrics, ...house.metrics]);
  assert.equal(summary["external:verified_journey"], 1);
  assert.equal(summary["house:verified_journey"], 1);
  assert.equal(summary["sponsored:verified_journey"], undefined);
});
