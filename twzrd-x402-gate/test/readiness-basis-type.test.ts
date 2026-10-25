/**
 * TwzrdReadinessBasisEntry is part of the public type surface, so a consumer reads
 * `card.basis[].observed_at` without a cast. The import below is the check: drop the
 * export from src/index.ts and `npm run typecheck` (tsconfig.check.json covers test/)
 * fails. The runtime asserts pin the two observed_at rules the doc comments state.
 * Run: npx tsx --test test/readiness-basis-type.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { TwzrdReadinessBasisEntry, TwzrdReadinessCard } from "../src/index.js";

test("readiness card basis entries are typed, and null observed_at carries its reason", () => {
  const measured: TwzrdReadinessBasisEntry = {
    class: "behavioral",
    kind: "settlement_history",
    source: "corpus",
    weight: 1,
    observed_at: "2026-10-24T18:02:11Z",
  };
  const honestNull: TwzrdReadinessBasisEntry = {
    class: "behavioral",
    observed_at: null,
    observed_at_null_reason: "no_evidence_measured",
  };
  const card: TwzrdReadinessCard = { decision: "warn", basis: [measured, honestNull] };
  assert.equal(card.basis?.length, 2);
  assert.equal(card.basis?.[0]?.observed_at, "2026-10-24T18:02:11Z");
  assert.equal(card.basis?.[1]?.observed_at, null);
  assert.equal(card.basis?.[1]?.observed_at_null_reason, "no_evidence_measured");
});

test("a card without basis still type-checks (the field is optional and nullable)", () => {
  const bare: TwzrdReadinessCard = { decision: "allow" };
  const nulled: TwzrdReadinessCard = { decision: "allow", basis: null };
  assert.equal(bare.basis, undefined);
  assert.equal(nulled.basis, null);
});
