import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyMainnetRun } from "../examples/offline-refusal-proof.js";
import { runForeignClientProof } from "../examples/foreign-client-proof.js";

const runner = fileURLToPath(new URL("../scripts/run-offline-refusal-proof.mjs", import.meta.url));
const guard = fileURLToPath(new URL("../scripts/offline-network-guard.cjs", import.meta.url));
const schema = JSON.parse(readFileSync(new URL("../schemas/refusal-proof.v1.schema.json", import.meta.url), "utf8"));

// Check this contract's structural JSON Schema keywords without another test
// dependency. Behavioral invariants below are asserted separately from shape.
function contract(value: unknown, shape: Record<string, any>): void {
  if (shape.$ref) return contract(value, schema.$defs[shape.$ref.split("/").at(-1)]);
  if ("const" in shape) assert.deepEqual(value, shape.const);
  if (shape.enum) assert.ok(shape.enum.includes(value), `unexpected enum ${value}`);
  if (shape.anyOf) {
    assert.ok(shape.anyOf.some((branch: Record<string, any>) => { try { contract(value, branch); return true; } catch { return false; } }));
    return;
  }
  if (shape.type === "null") assert.equal(value, null);
  if (shape.type === "boolean") assert.equal(typeof value, "boolean");
  if (shape.type === "string") {
    assert.equal(typeof value, "string");
    if (shape.pattern) assert.match(value as string, new RegExp(shape.pattern));
  }
  if (shape.type === "integer") {
    assert.ok(Number.isSafeInteger(value));
    if (shape.minimum !== undefined) assert.ok((value as number) >= shape.minimum);
  }
  if (shape.type === "array") {
    assert.ok(Array.isArray(value));
    if (shape.minItems !== undefined) assert.ok(value.length >= shape.minItems);
    if (shape.maxItems !== undefined) assert.ok(value.length <= shape.maxItems);
    for (const item of value) contract(item, shape.items);
  }
  if (shape.type === "object") {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    const object = value as Record<string, unknown>;
    for (const name of shape.required ?? []) assert.ok(Object.hasOwn(object, name), `missing ${name}`);
    for (const [name, item] of Object.entries(object)) {
      if (shape.properties?.[name]) contract(item, shape.properties[name]);
      else if (shape.additionalProperties === false) assert.fail(`unexpected field ${name}`);
      else if (typeof shape.additionalProperties === "object") contract(item, shape.additionalProperties);
    }
  }
}

test("real official and stock clients emit a valid mainnet fixture transcript", () => {
  const report = JSON.parse(execFileSync(process.execPath, [runner], { encoding: "utf8", timeout: 30_000 }));
  contract(report, schema);
  assert.equal(report.verified, true);
  assert.deepEqual(report.network_guard, { enabled: true, denied_egress_attempt_count: 0 });
  assert.deepEqual(report.runs.map((run: any) => `${run.client}/${run.case}`), [
    "official/block", "official/clean_control", "official/gate_absent",
    "x402-solana/block", "x402-solana/clean_control", "x402-solana/gate_absent", "official/post_approval_tamper",
  ]);
  for (const run of report.runs) {
    assert.equal(run.hook, run.client === "official" ? "onBeforePaymentCreation" : "beforePayment");
    assert.equal(run.verified, true);
    assert.ok(run.checks.length > 0 && run.checks.every((check: any) => check.ok));
    assert.equal(run.transaction_broadcast_count, 0);
    assert.equal(run.usdc_spent, 0);
    if (run.case === "block") {
      assert.equal(run.decision, "block");
      assert.equal(run.approved, false);
      assert.match(run.reason, /twzrd_decision_block/);
      assert.equal(run.signer_invocation_count, 0);
      assert.equal(run.payment_retry_count, 0);
      assert.deepEqual(run.rpc_methods, []);
    } else {
      assert.equal(run.signer_invocation_count, 1);
      assert.equal(run.payment_retry_count, 1);
      assert.equal(run.simulated_settlement_count, 1);
    }
  }
  const malformed = structuredClone(report);
  delete malformed.runs[0].transaction_broadcast_count;
  assert.throws(() => contract(malformed, schema));
});

test("unexpected RPC calls invalidate a run even if its other checks pass", async () => {
  const run = await runForeignClientProof("allow", { fixtureProfile: "mainnet" });
  run.rpcMethods.push("sendTransaction");
  const failed = verifyMainnetRun(run, []).filter(check => !check.ok).map(check => check.name);
  assert.ok(failed.includes("fixture/no_broadcast_rpc"));
  assert.ok(failed.includes("fixture/known_rpc_methods"));
});

test("the transcript cannot silently run without the offline guard", () => {
  const script = fileURLToPath(new URL("../examples/offline-refusal-proof.ts", import.meta.url));
  assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", script], { stdio: "pipe", timeout: 10_000 }),
    error => /offline guard is required/.test(String((error as { stderr?: Buffer }).stderr)));
});

test("offline guard rejects external fetch and raw TCP before making a connection", () => {
  const output = execFileSync(process.execPath, ["--require", guard, "--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    await assert.rejects(fetch('https://example.com/'), /OFFLINE_EGRESS_DENIED/);
    assert.throws(() => net.connect({host:'1.1.1.1',port:443}), /OFFLINE_EGRESS_DENIED/);
    assert.equal(globalThis[Symbol.for('twzrd.offline.network')].deniedCount(), 2);
    console.log('guard checked');
  `], { encoding: "utf8", timeout: 10_000 });
  assert.match(output, /guard checked/);
});

test("proof policy is deterministic despite ambient bypass configuration", () => {
  const report = JSON.parse(execFileSync(process.execPath, [runner], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, TWZRD_FAIL_OPEN: "true", TWZRD_BLOCK_DECISIONS: "", TWZRD_PREFLIGHT_MIN_SCORE: "999",
      TWZRD_INTEL_BASE: "https://example.com", TWZRD_REFUSE_WASH_FLAGGED: "1", TWZRD_REFUSE_UNEVALUATED: "1",
      TWZRD_GATE_ENABLED: "false", TWZRD_AUTO_GATE: "false" },
  }));
  assert.equal(report.verified, true);
  assert.equal(report.network_guard.denied_egress_attempt_count, 0);
});
