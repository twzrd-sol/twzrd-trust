import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import nacl from "tweetnacl";
import { STH_DOMAIN_V2, signSth } from "../src/sth.js";
import { merkleRoot, inclusionProof, consistencyProof } from "../src/merkle.js";
import { b58encode, bytesToHex } from "../src/util.js";

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

test("CLI: a receipt whose leaf is an array holding the proven leaf is refused on both invocations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-cli-"));
  try {
    const arrayLeaf = { leaf: [LIVE_LEAF] };
    const paidFile = join(dir, "paid.json");
    writeFileSync(paidFile, JSON.stringify({ ...PAID_RESPONSE, twzrd_receipt: arrayLeaf }));
    let stdout = "";
    await assert.rejects(
      run(process.execPath, [CLI, "inclusion", "--proof", paidFile]).catch((e) => { stdout = e.stdout; throw e; }),
    );
    assert.match(stdout, /twzrd_receipt\.leaf: leaf must be a string of 64 hex chars/);
    assert.doesNotMatch(stdout, /RESULT\s*: VALID/);

    const receiptFile = join(dir, "receipt.json");
    const proofFile = join(dir, "proof.json");
    const sthFile = join(dir, "sth.json");
    writeFileSync(receiptFile, JSON.stringify(arrayLeaf));
    writeFileSync(proofFile, JSON.stringify({ leaf_index: 0, tree_size: 1, audit_path: [] }));
    writeFileSync(sthFile, JSON.stringify(PAID_RESPONSE.log_inclusion.sth));
    let legacyOut = "";
    await assert.rejects(
      run(process.execPath, [CLI, "inclusion", "--receipt", receiptFile, "--proof", proofFile, "--sth", sthFile]).catch(
        (e) => { legacyOut = `${e.stdout}${e.stderr}`; throw e; },
      ),
    );
    assert.match(legacyOut, /error: leaf: leaf must be a string of 64 hex chars/);
    assert.doesNotMatch(legacyOut, /RESULT\s*: VALID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Run the CLI expecting a non-zero exit; returns stdout + stderr. */
async function runRefused(args: string[]): Promise<string> {
  let out = "";
  await assert.rejects(
    run(process.execPath, [CLI, ...args]).catch((e) => { out = `${e.stdout}${e.stderr}`; throw e; }),
    `expected a non-zero exit: ${args.join(" ")}`,
  );
  return out;
}

test("CLI: a receipt leaf of 0 or false is a type error, and the nested receipt's leaf does not stand in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-cli-"));
  try {
    const proofFile = join(dir, "proof.json");
    const sthFile = join(dir, "sth.json");
    writeFileSync(proofFile, JSON.stringify({ leaf_index: 0, tree_size: 1, audit_path: [] }));
    writeFileSync(sthFile, JSON.stringify(PAID_RESPONSE.log_inclusion.sth));
    for (const bad of [0, false]) {
      const paidFile = join(dir, "paid.json");
      writeFileSync(paidFile, JSON.stringify({ ...PAID_RESPONSE, twzrd_receipt: { leaf: bad } }));
      const whole = await runRefused(["inclusion", "--proof", paidFile]);
      assert.match(whole, /twzrd_receipt\.leaf: leaf must be a string of 64 hex chars/, String(bad));
      assert.doesNotMatch(whole, /RESULT\s*: VALID/);

      // 0 and false were read as "this document has no leaf of its own", so the
      // nested receipt's leaf was used and this printed VALID.
      const receiptFile = join(dir, "receipt.json");
      writeFileSync(receiptFile, JSON.stringify({ leaf: bad, twzrd_receipt: { leaf: LIVE_LEAF } }));
      const legacy = await runRefused(["inclusion", "--receipt", receiptFile, "--proof", proofFile, "--sth", sthFile]);
      assert.match(legacy, /error: leaf: leaf must be a string of 64 hex chars/, String(bad));
      assert.doesNotMatch(legacy, /RESULT\s*: VALID/);
    }
    // Unchanged: a wrapper with no leaf of its own (missing or null) is read through to the nested receipt.
    for (const wrapper of [{ twzrd_receipt: { leaf: LIVE_LEAF } }, { leaf: null, twzrd_receipt: { leaf: LIVE_LEAF } }]) {
      const receiptFile = join(dir, "receipt.json");
      writeFileSync(receiptFile, JSON.stringify(wrapper));
      const { stdout } = await run(process.execPath, [
        CLI, "inclusion", "--receipt", receiptFile, "--proof", proofFile, "--sth", sthFile,
      ]);
      assert.match(stdout, /RESULT\s*: VALID/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A 12-leaf log under a key made for this file, so a proof has a path to bend.
const kp = nacl.sign.keyPair();
const PIN = b58encode(kp.publicKey);
const ENTRIES = Array.from({ length: 12 }, (_, i) =>
  Uint8Array.from({ length: 32 }, (_, j) => (i * 29 + j * 7 + 3) & 0xff),
);
const headAt = (size: number, ts: number) =>
  signSth(
    { domain: STH_DOMAIN_V2, log_id: "cli.test/v1", key_id: "k1", tree_size: size, timestamp_unix: ts, root: bytesToHex(merkleRoot(ENTRIES.slice(0, size))) },
    kp.secretKey,
  );
// Each prints as the hash it wraps in JSON-free code; in a JSON file only the arrays survive, which is the case that verified.
const BENT: Array<[string, (h: string) => unknown]> = [
  ["array holding the hash", (h) => [h]],
  ["nested array holding the hash", (h) => [[h]]],
  ["number", () => 12345],
  ["zero", () => 0],
  ["false", () => false],
  ["null", () => null],
];

test("CLI: an audit_path entry that is not a string is refused on both inclusion invocations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-cli-"));
  try {
    const leaf = bytesToHex(ENTRIES[5]);
    const path = inclusionProof(ENTRIES, 5).map(bytesToHex);
    const block = { leaf, leaf_index: 5, tree_size: 12, audit_path: path as unknown[], sth: headAt(12, 100) };
    const file = join(dir, "block.json");
    const proofOnly = join(dir, "proof.json");
    const write = (audit_path: unknown) => {
      writeFileSync(file, JSON.stringify({ ...block, audit_path }));
      writeFileSync(proofOnly, JSON.stringify({ ...block, leaf: undefined, audit_path }));
    };
    write(path);
    const direct = await run(process.execPath, [CLI, "inclusion", "--proof", file, "--pubkey", PIN]);
    assert.match(direct.stdout, /RESULT\s*: VALID/);
    const legacy = await run(process.execPath, [CLI, "inclusion", "--leaf", leaf, "--proof", proofOnly, "--pubkey", PIN]);
    assert.match(legacy.stdout, /RESULT\s*: VALID/);

    for (const [label, wrap] of BENT) {
      write(path.map((h, i) => (i === 1 ? wrap(h) : h)));
      const d = await runRefused(["inclusion", "--proof", file, "--pubkey", PIN]);
      assert.match(d, /audit path: audit_path\[1\] must be a hex string/, label);
      assert.doesNotMatch(d, /RESULT\s*: VALID/, label);
      const l = await runRefused(["inclusion", "--leaf", leaf, "--proof", proofOnly, "--pubkey", PIN]);
      assert.match(l, /error: audit_path\[1\] must be a hex string/, label);
      assert.doesNotMatch(l, /RESULT\s*: VALID/, label);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: consistency and equivocation refuse a path entry that is not a string", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-cli-"));
  try {
    const oldFile = join(dir, "old.json");
    const newFile = join(dir, "new.json");
    const proofFile = join(dir, "path.json");
    writeFileSync(oldFile, JSON.stringify(headAt(7, 100)));
    writeFileSync(newFile, JSON.stringify(headAt(12, 200)));
    const path = consistencyProof(ENTRIES, 7).map(bytesToHex);
    assert.ok(path.length >= 2);
    const consistency = ["consistency", "--old", oldFile, "--new", newFile, "--proof", proofFile, "--pubkey", PIN];
    const equivocation = ["equivocation", "--a", oldFile, "--b", newFile, "--proof", proofFile, "--pubkey", PIN];

    for (const shape of [(p: unknown[]) => p, (p: unknown[]) => ({ path: p })]) {
      writeFileSync(proofFile, JSON.stringify(shape(path)));
      assert.match((await run(process.execPath, [CLI, ...consistency])).stdout, /RESULT\s*: VALID/);
      assert.match((await run(process.execPath, [CLI, ...equivocation])).stdout, /consistency proof verifies/);

      for (const [label, wrap] of BENT) {
        writeFileSync(proofFile, JSON.stringify(shape(path.map((h, i) => (i === 1 ? wrap(h) : h)))));
        const c = await runRefused(consistency);
        assert.match(c, /error: path\[1\] must be a hex string/, label);
        assert.doesNotMatch(c, /RESULT\s*: VALID/, label);
        // The array shapes used to print as the hash, so this reported the pair consistent.
        const e = await runRefused(equivocation);
        assert.match(e, /error: path\[1\] must be a hex string/, label);
        assert.doesNotMatch(e, /consistency proof verifies/, label);
      }
    }
    // A path that is not an array at all.
    writeFileSync(proofFile, JSON.stringify({ path: path.join("") }));
    assert.match(await runRefused(equivocation), /error: path must be an array of hex strings/);
    assert.match(await runRefused(consistency), /error: path must be an array of 32-byte hex strings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
