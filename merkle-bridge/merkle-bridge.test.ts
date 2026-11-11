import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sha3 from "js-sha3";
import { verifyLedgerFile } from "../agent-killswitch/src/chain.js";
import {
  GENESIS,
  LedgerNotBridgeable,
  bridgeSpendLedger,
  lineHash,
  splitLedgerLines,
  verifyLinearChain,
} from "./index.js";

// Expected values are computed here with js-sha3 directly, not with the
// module under test, so a wrong prefix or split in the module fails the test.
const KECCAK_EMPTY = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
const enc = new TextEncoder();
const keccakHex = (bytes: Uint8Array): string => sha3.keccak256(bytes);
const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
const leaf = (line: string | Uint8Array): string =>
  keccakHex(Uint8Array.from([0x00, ...(typeof line === "string" ? enc.encode(line) : line)]));
const node = (l: string, r: string): string => keccakHex(Uint8Array.from([0x01, ...fromHex(l), ...fromHex(r)]));
const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

/** Rows as agent-killswitch writes them: each `prev` is the SHA-256 of the line before. */
function chain(rows: Array<Record<string, unknown>>, first = GENESIS): string[] {
  let prev = first;
  return rows.map((row) => {
    const line = JSON.stringify({ ...row, prev });
    prev = sha256(line);
    return line;
  });
}
const file = (lines: string[]): Uint8Array => enc.encode(lines.map((l) => `${l}\n`).join(""));
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ts: `2026-11-11T00:00:0${i + 1}Z`, model: "gpt-4o", usd: (i + 1) / 1000 }));
const FIVE = chain(rows(5));

const refused = (bytes: Uint8Array, pattern: RegExp, opts = {}) =>
  assert.throws(
    () => bridgeSpendLedger(bytes, opts),
    (e: unknown) => e instanceof LedgerNotBridgeable && pattern.test(e.message),
  );

test("an empty ledger bridges to the keccak256(\"\") sentinel", () => {
  const out = bridgeSpendLedger(new Uint8Array(0));
  assert.deepEqual(
    { treeSize: out.treeSize, rootHex: out.rootHex, leaves: out.leaves, chainHead: out.chainHead },
    { treeSize: 0, rootHex: KECCAK_EMPTY, leaves: [], chainHead: null },
  );
});

test("leaves are keccak256(0x00 || exact line bytes) and the root follows RFC 6962", () => {
  const l = FIVE.map(leaf);
  const want = [
    l[0],
    node(l[0], l[1]),
    node(node(l[0], l[1]), l[2]),
    node(node(l[0], l[1]), node(l[2], l[3])),
    node(node(node(l[0], l[1]), node(l[2], l[3])), l[4]),
  ];
  for (let n = 1; n <= 5; n++) {
    const out = bridgeSpendLedger(file(FIVE.slice(0, n)));
    assert.equal(out.treeSize, n);
    assert.deepEqual(out.leaves, l.slice(0, n));
    assert.equal(out.rootHex, want[n - 1], `root for ${n} lines`);
    assert.equal(out.root.length, 32);
    assert.equal(out.chainHead, sha256(FIVE[n - 1]));
  }
});

test("the same bytes give the same root; Buffer and Uint8Array inputs agree", () => {
  const bytes = file(FIVE);
  const first = bridgeSpendLedger(bytes).rootHex;
  for (let i = 0; i < 5; i++) assert.equal(bridgeSpendLedger(bytes).rootHex, first);
  assert.equal(bridgeSpendLedger(Buffer.from(bytes)).rootHex, first);
  assert.notEqual(bridgeSpendLedger(file(chain(rows(5).reverse()))).rootHex, first);
});

test("lines that do not chain are refused (the PR's first fixtures had prev \"deadbeef\")", () => {
  const unchained = [
    '{"ts":"2026-11-11T00:00:01Z","model":"gpt-4o","usd":0.001,"prev":"genesis"}',
    '{"ts":"2026-11-11T00:00:02Z","model":"gpt-4o","usd":0.002,"prev":"deadbeef"}',
  ];
  refused(file(unchained), /line 2: prev is not the SHA-256/);
});

test("edits, removals, reorders and forks are refused at the first line they break", () => {
  const edited = [...FIVE];
  edited[1] = edited[1].replace('"usd":0.002', '"usd":0.0002');
  refused(file(edited), /line 3: prev is not/);

  refused(file([FIVE[0], FIVE[2], FIVE[3]]), /line 2: prev is not/);
  refused(file([FIVE[0], FIVE[2], FIVE[1]]), /line 2: prev is not/);

  // A fork: line 3 names line 1, as two writers reading the same tail would.
  const fork = [FIVE[0], FIVE[1], JSON.stringify({ ...rows(3)[2], prev: sha256(FIVE[0]) })];
  refused(file(fork), /line 3: prev is not/);
});

test("rows the chain does not bind are refused", () => {
  const legacy = JSON.stringify({ ts: "2026-11-10T23:59:59Z", usd: 0.5 });
  refused(file([legacy, ...chain(rows(2), sha256(legacy))]), /line 1: no prev/);
  refused(file([...FIVE.slice(0, 2), JSON.stringify(rows(3)[2])]), /line 3: no prev/);
  refused(file(chain(rows(2), sha256("something else"))), /line 1: prev must be "genesis"/);
  refused(enc.encode(`${FIVE[0]}\n\n${FIVE[1]}\n`), /line 2: empty line/);
  refused(enc.encode(`${FIVE[0]}\n${FIVE[1]}`), /line 2: bytes after the last newline/);
  refused(enc.encode(`${FIVE[0]}\n{"ts":"2026-11-11T00:0`), /torn/);
  refused(file([FIVE[0], "not json"]), /line 2: not valid UTF-8 JSON/);
  refused(file([FIVE[0], "[1,2]"]), /line 2: not a JSON object/);
  refused(file([FIVE[0], JSON.stringify({ usd: 1, prev: 123 })]), /line 2: prev is not/);
});

test("bytes are exact: invalid UTF-8 is refused and CR is part of the line", () => {
  const bad = Uint8Array.from([...enc.encode('{"note":"'), 0xff, ...enc.encode(`","prev":"${GENESIS}"}\n`)]);
  refused(bad, /line 1: not valid UTF-8 JSON/);

  // Rewriting an LF ledger with CRLF changes every line's bytes, so its prev links break.
  refused(enc.encode(FIVE.slice(0, 2).map((l) => `${l}\r\n`).join("")), /line 2: prev is not/);
  // A ledger chained over CR-terminated bytes bridges, and its leaves include the CR.
  const first = `${JSON.stringify({ usd: 1, prev: GENESIS })}\r`;
  const second = `${JSON.stringify({ usd: 2, prev: sha256(first) })}\r`;
  const out = bridgeSpendLedger(enc.encode(`${first}\n${second}\n`));
  assert.deepEqual(out.leaves, [leaf(first), leaf(second)]);
});

test("expectedHead binds the bytes to a head recorded earlier", () => {
  const bytes = file(FIVE);
  assert.equal(bridgeSpendLedger(bytes, { expectedHead: sha256(FIVE[4]) }).treeSize, 5);
  refused(bytes, /does not end at the expected head/, { expectedHead: sha256(FIVE[3]) });
  // A full rewrite with fresh prev values chains, so only the recorded head catches it.
  const rewritten = file(chain(rows(5).map((r) => ({ ...r, usd: 0 }))));
  assert.equal(bridgeSpendLedger(rewritten).treeSize, 5);
  refused(rewritten, /does not end at the expected head/, { expectedHead: sha256(FIVE[4]) });
  refused(new Uint8Array(0), /does not end at the expected head/, { expectedHead: sha256(FIVE[0]) });
});

test("whatever the bridge accepts, agent-killswitch verify-ledger --strict accepts with the same head", () => {
  const legacy = JSON.stringify({ usd: 0.5 });
  const fixtures: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["five", file(FIVE)],
    ["one", file(FIVE.slice(0, 1))],
    ["reordered", file([FIVE[0], FIVE[2], FIVE[1]])],
    ["fork", file([FIVE[0], FIVE[1], JSON.stringify({ usd: 3, prev: sha256(FIVE[0]) })])],
    ["legacy", file([legacy, ...chain(rows(2), sha256(legacy))])],
    ["blank", enc.encode(`${FIVE[0]}\n\n${FIVE[1]}\n`)],
    ["torn", enc.encode(`${FIVE[0]}\n{"partial`)],
    ["unparseable", file([FIVE[0], "not json", JSON.stringify({ usd: 3, prev: sha256("not json") })])],
  ];
  const dir = mkdtempSync(join(tmpdir(), "merkle-bridge-"));
  try {
    let strictOkButRefused = 0;
    for (const [name, bytes] of fixtures) {
      const path = join(dir, `${name}.jsonl`);
      writeFileSync(path, bytes);
      const report = verifyLedgerFile(path, { strict: true });
      let out: ReturnType<typeof bridgeSpendLedger>;
      try {
        out = bridgeSpendLedger(bytes);
      } catch (e) {
        assert.ok(e instanceof LedgerNotBridgeable, `${name}: ${String(e)}`);
        if (report.ok) strictOkButRefused++;
        continue;
      }
      assert.equal(report.ok, true, `${name}: bridged but verify-ledger --strict is not ok`);
      assert.equal(report.torn_tail, false, name);
      assert.equal(report.legacy, 0, name);
      assert.equal(report.lines, out.treeSize, name);
      assert.equal(report.head, out.chainHead, name);
    }
    // legacy, blank and torn pass --strict; the bridge refuses them.
    assert.equal(strictOkButRefused, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("helpers: splitLedgerLines keeps exact bytes; verifyLinearChain returns the head", () => {
  const lines = splitLedgerLines(file(FIVE));
  assert.deepEqual(lines.map((l) => Buffer.from(l).toString("utf8")), FIVE);
  assert.equal(verifyLinearChain(lines), sha256(FIVE[4]));
  assert.equal(verifyLinearChain([]), null);
  assert.equal(lineHash(enc.encode(FIVE[0])), sha256(FIVE[0]));
});
