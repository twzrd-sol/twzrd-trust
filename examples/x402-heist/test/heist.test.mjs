import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const HONEST = "0x1111111111111111111111111111111111111111";
const ids = ["honest", "lowercase-ok", "gouge", "swap-payto", "fake-asset", "chain-hop", "testnet-usdc",
  "decoy-pair", "decoy-reverse", "split-brain", "amount-exponent", "amount-hex", "amount-leading-zero",
  "amount-fraction", "amount-negative", "amount-overflow", "space-payto", "redirect", "drip", "drip-paths", "drip-agents"];

test("published gate faces every trick offline, pays controls, caps drips and cleans up", { timeout: 90_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "heist-test-"));
  const log = join(dir, "tripwire.log");
  try {
    const result = spawnSync(process.execPath, ["--import", "./tripwire.mjs", "heist.mjs", "--json"], {
      cwd, encoding: "utf8", timeout: 80_000,
      // Do not inherit wallet credentials or gate overrides from the caller.
      env: { PATH: process.env.PATH, TMPDIR: dir, TRIPWIRE_LOG: log },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.gate, "0.28.1");
    assert.equal(report.tripwireHits, 0);
    assert.deepEqual(report.differences, []);
    assert.deepEqual(report.rows.map(row => row.id), ids);
    for (const row of report.rows) {
      assert.ok(["DEFENDED", "CAPPED"].includes(row.verdict), row.id);
      if (row.verdict === "DEFENDED") {
        assert.equal(row.signatures, 0, row.id);
        assert.deepEqual(row.payments, [], row.id);
      }
      assert.equal(row.signatures, row.payments.length, row.id);
      for (const payment of row.payments) {
        assert.equal(payment.to.toLowerCase(), HONEST, row.id);
        assert.ok(BigInt(payment.value) <= 10_000n, row.id);
      }
    }
    for (const id of ["honest", "lowercase-ok", "decoy-pair"]) {
      const row = report.rows.find(row => row.id === id);
      assert.equal(row.signatures, 1, id);
      assert.equal(row.payments.length, 1, id);
      assert.equal(row.payments[0].value, "5000", id);
      assert.equal(row.totalUsdc, "0.005000", id);
    }
    for (const id of ["drip", "drip-paths", "drip-agents"]) {
      const row = report.rows.find(row => row.id === id);
      assert.equal(row.verdict, "CAPPED", id);
      assert.equal(row.payments.length, 3, id);
      assert.equal(row.totalUsdc, "0.027000", id);
      assert.equal(row.reason, "hourly_budget_exceeded", id);
    }
    // Every per-trick ledger directory was removed, including any queued decision writes.
    assert.deepEqual(readdirSync(dir).filter(name => name !== "tripwire.log"), []);
    if (readdirSync(dir).includes("tripwire.log")) assert.equal(readFileSync(log, "utf8"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tripwire refuses and records a non-loopback fetch before network I/O", () => {
  const result = spawnSync(process.execPath, ["--import", "./tripwire.mjs", "--input-type=module", "-e",
    'try { await fetch("https://example.invalid/blocked"); process.exitCode = 1; } ' +
    'catch { console.log(JSON.stringify(globalThis.__tripwireHits)); }'],
  { cwd, encoding: "utf8", timeout: 5_000, env: { PATH: process.env.PATH } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["https://example.invalid/blocked"]);
});
