/**
 * Durable spend ledger: replay across instances, window sums, hash-chain
 * tamper detection (no network, real tmp files). Run: npx tsx test/spend-ledger-file.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSpendLedger } from "../src/spend-ledger-file.js";

const dir = mkdtempSync(join(tmpdir(), "twzrd-ledger-"));
const HOUR = 3_600_000;
const t0 = 1_700_000_000_000;

/* 1. Fresh ledger records and sums with window filtering. */
const path = join(dir, "nested", "spend.jsonl");
const a = createFileSpendLedger(path);
a.record("counterparty:X", 10_000n, t0);
a.record("counterparty:X", 5_000n, t0 + HOUR);
a.record("mandate:m1", 7_000n, t0 + HOUR);
assert.equal(a.spentMicro("counterparty:X", 2 * HOUR, t0 + HOUR), 15_000n);
assert.equal(a.spentMicro("counterparty:X", HOUR / 2, t0 + HOUR), 5_000n, "old row outside window");
assert.equal(a.firstSeen("counterparty:X"), t0);
assert.equal(a.firstSeen("nope"), undefined);

/* 2. A new instance over the same file replays identical state. */
const b = createFileSpendLedger(path);
assert.equal(b.spentMicro("counterparty:X", 2 * HOUR, t0 + HOUR), 15_000n, "caps survive restart");
assert.equal(b.spentMicro("mandate:m1", 2 * HOUR, t0 + HOUR), 7_000n);
assert.equal(b.firstSeen("counterparty:X"), t0);
b.record("counterparty:X", 1_000n, t0 + 2 * HOUR);
assert.equal(
  createFileSpendLedger(path).spentMicro("counterparty:X", 3 * HOUR, t0 + 2 * HOUR),
  16_000n,
  "append after replay keeps the chain",
);

/* 3. Tampering with an amount breaks the chain on next load. */
const tampered = readFileSync(path, "utf8").replace('"micro":"5000"', '"micro":"1"');
assert.notEqual(tampered, readFileSync(path, "utf8"), "fixture edit must hit a row");
writeFileSync(path, tampered);
assert.throws(() => createFileSpendLedger(path), /chain broken/);

/* 4. A non-JSON line fails closed. */
const p2 = join(dir, "corrupt.jsonl");
writeFileSync(p2, "not json\n");
assert.throws(() => createFileSpendLedger(p2), /corrupt row/);

/* 5. Deleting the middle row (truncation-style edit) breaks the chain. */
const p3 = join(dir, "drop.jsonl");
const c = createFileSpendLedger(p3);
c.record("s", 1n, t0);
c.record("s", 2n, t0 + 1);
c.record("s", 3n, t0 + 2);
const lines = readFileSync(p3, "utf8").trim().split("\n");
writeFileSync(p3, [lines[0], lines[2]].join("\n") + "\n");
assert.throws(() => createFileSpendLedger(p3), /chain broken/);

console.log("spend-ledger-file: all assertions passed");
