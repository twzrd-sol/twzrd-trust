/**
 * Proof-doc export parity: symbols named in public README/proof harness must exist
 * on the checked-in package entrypoint (not only on npm).
 * Run: npx tsx test/export-parity.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as gate from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

const PROOF_EXPORTS = [
  "installTwzrdAutoGate",
  "withTwzrdGuard",
  "installTwzrdX402ClientHook",
  "twzrdBeforePaymentCreation",
  "twzrdApprovePayment",
  "twzrdPreflight",
  "wrapFetchWithTwzrdGate",
  "twzrdOnPaymentRequested",
  "evaluate_x402_resource",
  "safeFetch",
] as const;

function symbolsFromDocs(): string[] {
  const paths = [
    join(repoRoot, "README.md"),
    join(repoRoot, "twzrd-x402-gate/README.md"),
    join(repoRoot, "docs/proofs/seller-graph-payguard-closeout-2026-07-12.md"),
    join(repoRoot, "docs/proofs/examples/zero-spend-guard-check.mjs"),
  ];
  const found = new Set<string>();
  const re = /\b(installTwzrdAutoGate|withTwzrdGuard|installTwzrdX402ClientHook|twzrdBeforePaymentCreation|twzrdApprovePayment|twzrdPreflight|wrapFetchWithTwzrdGate|twzrdOnPaymentRequested|evaluate_x402_resource|safeFetch)\b/g;
  for (const p of paths) {
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(re)) found.add(m[1]!);
  }
  return [...found].sort();
}

function run() {
  const documented = symbolsFromDocs();
  assert.ok(documented.length > 0, "expected proof docs to name at least one export");

  const missing: string[] = [];
  for (const name of documented) {
    if ((gate as Record<string, unknown>)[name] === undefined) missing.push(name);
  }
  assert.deepEqual(
    missing,
    [],
    `proof docs reference exports missing from src/index.ts: ${missing.join(", ")}`,
  );

  for (const name of PROOF_EXPORTS) {
    assert.notEqual(
      (gate as Record<string, unknown>)[name],
      undefined,
      `required proof export ${name}`,
    );
  }

  console.log(
    `export-parity.test.ts: ALL PASSED (${documented.length} doc symbols, ${PROOF_EXPORTS.length} required)`,
  );
}

run();