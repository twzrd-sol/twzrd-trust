/**
 * Runnable verification for the dep-free trust-gate core.
 * Run: npx tsx test/gate.test.ts   (no test framework / network needed)
 *
 * Fixtures mirror the live PayAI-rail merchants verified 2026-06-14:
 *   34w53Ukh -> decision=block/30 (wash-flagged tail)  => MUST block
 *   7uh2ibD1 -> decision=warn/45  (clean hub)           => MUST allow
 */
import assert from "node:assert";
import { checkTrust, canSpendSafely } from "../src/gate.ts";

function mockFetch(card: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({ ok, status, json: async () => ({ readiness_card: card }) })) as unknown as typeof fetch;
}
const throwFetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

async function main() {
  // 1. wash-flagged seller -> hard block
  const blockCfg = { fetchImpl: mockFetch({ decision: "block", trust_score: 30, can_spend: false }) };
  let v = await checkTrust("34w53Ukh", blockCfg);
  assert.equal(v.blocked, true, "block decision must block");
  assert.equal(v.decision, "block");
  assert.equal(await canSpendSafely("34w53Ukh", blockCfg), false, "canSpendSafely false on block");

  // 2. clean seller (warn) -> NOT a hard block
  v = await checkTrust("7uh2ibD1", { fetchImpl: mockFetch({ decision: "warn", trust_score: 45, can_spend: false }) });
  assert.equal(v.blocked, false, "warn must not hard-block");
  assert.equal(v.decision, "warn");

  // 3. minScore override blocks a low warn
  v = await checkTrust("x", { minScore: 50, fetchImpl: mockFetch({ decision: "warn", trust_score: 45, can_spend: false }) });
  assert.equal(v.blocked, true, "trust_score below minScore must block");

  // 4. network outage -> fail-open (NOT blocked), gateAvailable=false
  v = await checkTrust("y", { fetchImpl: throwFetch });
  assert.equal(v.blocked, false, "outage must fail-open, not brick the agent");
  assert.equal(v.gateAvailable, false);

  // 5. HTTP 5xx -> fail-open
  v = await checkTrust("z", { fetchImpl: mockFetch({}, false, 502) });
  assert.equal(v.blocked, false);
  assert.equal(v.gateAvailable, false);

  // 6. strict mode (failOpen:false) -> outage BLOCKS instead of failing open
  v = await checkTrust("s", { failOpen: false, fetchImpl: throwFetch });
  assert.equal(v.blocked, true, "strict mode must block on outage");
  assert.equal(v.gateAvailable, false);
  assert.equal(v.decision, "block");

  console.log("OK gate.test: 6/6 passed");
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
