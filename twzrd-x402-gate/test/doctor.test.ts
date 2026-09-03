/**
 * twzrd-gate-doctor: host detection + the offline refusal proof.
 *
 * The refusal proof is the load-bearing part. An adoption tool that PRINTS
 * "the gate refuses wash sellers" without demonstrating it is marketing; the
 * doctor must actually drive the policy and observe that no signer ran. If this
 * test ever passes while `signerInvocations > 0`, the tool is lying to operators.
 */

import assert from "node:assert/strict";

import { detectHosts, proveRefusal } from "../src/doctor.js";

async function run() {
  // ── host detection ────────────────────────────────────────────────
  assert.deepEqual(
    detectHosts({ dependencies: { "@x402/core": "^2.9.0" } }).map((h) => h.id),
    ["x402-client"],
    "official x402 client detected",
  );
  assert.deepEqual(
    detectHosts({ dependencies: { "@solana/pay-kit": "^0.9.0" } }).map((h) => h.id),
    ["pay-kit"],
    "PayKit detected",
  );
  assert.deepEqual(
    detectHosts({ dependencies: { "solana-agent-kit": "^2.0.0" } }).map((h) => h.id),
    ["solana-agent-kit"],
    "SAK detected",
  );
  assert.deepEqual(
    detectHosts({ devDependencies: { "@elizaos/core": "^1.0.0" } }).map((h) => h.id),
    ["elizaos"],
    "detection reads devDependencies too",
  );
  assert.deepEqual(
    detectHosts({ dependencies: { lodash: "^4" } }),
    [],
    "unrelated project detects nothing (must not false-positive)",
  );
  assert.deepEqual(detectHosts(null), [], "missing package.json is not a crash");

  // Most-specific-first ordering: a project with both should be told about the
  // SAK seat first, because that is where its signing actually happens.
  const both = detectHosts({
    dependencies: { "solana-agent-kit": "^2", "@x402/core": "^2" },
  }).map((h) => h.id);
  assert.equal(both[0], "solana-agent-kit", "SAK ranks before the raw client");
  assert.equal(both.length, 2, "both surfaces reported");

  const payKitAndCore = detectHosts({
    dependencies: { "@solana/pay-kit": "^0.9", "@x402/core": "^2" },
  }).map((h) => h.id);
  assert.equal(payKitAndCore[0], "pay-kit", "PayKit ranks before the raw client");

  // Every host entry must be actionable, not a stub.
  for (const h of detectHosts({
    dependencies: {
      "solana-agent-kit": "1",
      "@x402/core": "1",
      "@solana/pay-kit": "1",
      "@elizaos/core": "1",
      "@goat-sdk/core": "1",
      "x402-fetch": "1",
    },
  })) {
    assert.ok(h.install.startsWith("npm install"), `${h.id} has an install line`);
    assert.ok(h.snippet.includes("twzrd"), `${h.id} snippet imports the gate`);
    assert.ok(h.label.length > 3, `${h.id} has a human label`);
  }

  // ── the refusal proof ─────────────────────────────────────────────
  const proof = await proveRefusal();
  assert.equal(proof.refused, true, "wash-flagged seller must be refused");
  assert.equal(
    proof.signerInvocations,
    0,
    "signer must never run on a refused payment — this is the whole claim",
  );
  assert.ok(proof.reason.length > 0, "refusal carries a machine-readable reason");
  assert.match(
    proof.reason,
    /block|wash|refus/i,
    "reason names why it was refused",
  );

  console.log("doctor.test.ts: ALL PASSED");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
