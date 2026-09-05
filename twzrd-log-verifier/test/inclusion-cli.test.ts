import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// Same live genesis head as client.test.ts's log-inclusion suite
// (https://intel.twzrd.xyz/v1/log/sth, 2026-09-04) — a paid response's
// `log_inclusion` block, exactly as a buyer receives it.
const LIVE_LEAF = "0xf7e88f2666a0590d8cf7d426d4842e29a23b66607f2c0a691bf6fc7d0d63ba8f";
const PAID_RESPONSE = {
  twzrd_receipt: { leaf: LIVE_LEAF },
  log_inclusion: {
    log_id: "intel.twzrd.xyz/v6",
    leaf: LIVE_LEAF,
    leaf_index: 0,
    tree_size: 1,
    audit_path: [],
    sth: {
      domain: "TWZRD:RECEIPT_LOG_STH_V1",
      log_id: "intel.twzrd.xyz/v6",
      tree_size: 1,
      timestamp_unix: 1788450541,
      root: "0x811e1fee65f06c5cfcfee8f338e933c1d3dd261c4c09b8f2793b62bea7ea6db4",
      signature: "5tgH6Y9x1pcE5eDWjaNb8reUpuy88A5xNanSsJu1A5hEgKbH2kwZtAev6ifE9RWTspkvkvhvuLEGtPbpEN5yVete",
      signing_pubkey: "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS",
    },
    anchor: null,
    verify: `/v1/log/proof/inclusion?leaf=${LIVE_LEAF}`,
  },
};

test("CLI: `inclusion --proof <paid-response.json>` with no --leaf/--sth verifies the live head", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-cli-"));
  try {
    const file = join(dir, "paid.json");
    writeFileSync(file, JSON.stringify(PAID_RESPONSE));
    const { stdout } = await run(process.execPath, [CLI, "inclusion", "--proof", file]);
    assert.match(stdout, /RESULT\s*: VALID/);
    assert.match(stdout, new RegExp(LIVE_LEAF.slice(2, 10)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: the same proof with a tampered root exits non-zero and never prints VALID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-cli-"));
  try {
    const tampered = structuredClone(PAID_RESPONSE);
    const r = tampered.log_inclusion.sth.root;
    tampered.log_inclusion.sth.root = r.slice(0, -1) + (r.endsWith("0") ? "1" : "0");
    const file = join(dir, "paid.json");
    writeFileSync(file, JSON.stringify(tampered));
    let stdout = "";
    await assert.rejects(
      run(process.execPath, [CLI, "inclusion", "--proof", file]).catch((e) => { stdout = e.stdout; throw e; }),
    );
    assert.doesNotMatch(stdout, /RESULT\s*: VALID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: legacy --receipt/--proof/--sth invocation still works unchanged (no regression)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-cli-"));
  try {
    const receiptFile = join(dir, "receipt.json");
    const proofFile = join(dir, "proof.json");
    const sthFile = join(dir, "sth.json");
    writeFileSync(receiptFile, JSON.stringify({ leaf: LIVE_LEAF }));
    writeFileSync(proofFile, JSON.stringify({ leaf_index: 0, tree_size: 1, audit_path: [] }));
    writeFileSync(sthFile, JSON.stringify(PAID_RESPONSE.log_inclusion.sth));
    const { stdout } = await run(process.execPath, [
      CLI, "inclusion", "--receipt", receiptFile, "--proof", proofFile, "--sth", sthFile,
    ]);
    assert.match(stdout, /RESULT\s*: VALID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
