import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertChainIntact,
  assertHashBackend,
  bridgeSpendLedger,
  hex,
  leafHash,
  lineToEntryBytes,
  nodeHash,
  KECCAK_EMPTY,
  STH_DOMAIN,
} from "../src/merkle-bridge.ts";

const LINE_1 = '{"ts":"2026-11-11T00:00:01Z","model":"gpt-4o","usd":0.001,"prev":"genesis"}';
const LINE_2 = '{"ts":"2026-11-11T00:00:02Z","model":"gpt-4o","usd":0.002,"prev":"deadbeef"}';
const LINE_3 = '{"ts":"2026-11-11T00:00:03Z","model":"gpt-4o","usd":0.003,"prev":"beefdead"}';

const INTACT = {
  ok: true, strict: true, lines: 3, chained: 3, legacy: 0,
  unchained: [], unparseable: [], forks: [], breaks: [],
  torn_tail: false, head: null, head_line: null,
};
const BROKEN = { ...INTACT, ok: false };

test("keccak backend self-test passes (guards SHA-3 vs Keccak mixups)", () => {
  assertHashBackend();
  assert.equal(KECCAK_EMPTY, "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
});

test("lineToEntryBytes strips exactly one trailing LF or CRLF and nothing else", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  assert.deepEqual([...lineToEntryBytes("abc\n")], [...bytes("abc")]);
  assert.deepEqual([...lineToEntryBytes("abc\r\n")], [...bytes("abc")]);
  assert.deepEqual([...lineToEntryBytes("abc")], [...bytes("abc")]);
  assert.deepEqual([...lineToEntryBytes("abc  \n")], [...bytes("abc  ")]);
  assert.equal(lineToEntryBytes("\n").length, 0);
});

test("leaves are keccak256(0x00 || entry_bytes)", () => {
  const a = leafHash(lineToEntryBytes(LINE_1));
  const b = leafHash(lineToEntryBytes(LINE_1 + "\n"));
  assert.deepEqual(a, b);
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, leafHash(lineToEntryBytes(LINE_2)));
});

test("empty ledger bridges to the keccak(\"\") sentinel, not a crash", () => {
  const out = bridgeSpendLedger([], INTACT);
  assert.equal(out.treeSize, 0);
  assert.equal(out.rootHex, KECCAK_EMPTY);
  assert.equal(out.sthDomain, STH_DOMAIN);
});

test("single line root equals its leaf hash (RFC 6962 MTH)", () => {
  const out = bridgeSpendLedger([LINE_1], INTACT);
  assert.equal(out.treeSize, 1);
  assert.equal(out.rootHex, out.leaves[0]);
});

test("two lines root is the node hash of the two leaves", () => {
  const out = bridgeSpendLedger([LINE_1, LINE_2], INTACT);
  const [l1, l2] = [leafHash(lineToEntryBytes(LINE_1)), leafHash(lineToEntryBytes(LINE_2))];
  assert.equal(out.rootHex, hex(nodeHash(l1, l2)));
});

test("three lines root splits k=2 (RFC 6962 largest power of two strictly below n)", () => {
  const out = bridgeSpendLedger([LINE_1, LINE_2, LINE_3], INTACT);
  const [l1, l2, l3] = [
    leafHash(lineToEntryBytes(LINE_1)),
    leafHash(lineToEntryBytes(LINE_2)),
    leafHash(lineToEntryBytes(LINE_3)),
  ];
  assert.equal(out.rootHex, hex(nodeHash(nodeHash(l1, l2), l3)));
});

test("four lines root is the node hash of two two-line subtrees", () => {
  const four = [LINE_1, LINE_2, LINE_3, LINE_1 + " "];
  const out = bridgeSpendLedger(four, INTACT);
  const [l1, l2, l3, l4] = out.leaves.map((h) => Uint8Array.from(Buffer.from(h, "hex")));
  assert.equal(out.rootHex, hex(nodeHash(nodeHash(l1, l2), nodeHash(l3, l4))));
});

test("determinism: identical lines 1..N produce identical roots across runs", () => {
  const expected = bridgeSpendLedger([LINE_1, LINE_2, LINE_3], INTACT).rootHex;
  for (let i = 0; i < 5; i += 1) {
    assert.equal(bridgeSpendLedger([LINE_1 + "\n", LINE_2 + "\n", LINE_3], INTACT).rootHex, expected);
  }
});

test("order matters: swapping two lines changes the root", () => {
  const a = bridgeSpendLedger([LINE_1, LINE_2, LINE_3], INTACT);
  const b = bridgeSpendLedger([LINE_2, LINE_1, LINE_3], INTACT);
  assert.notEqual(a.rootHex, b.rootHex);
});

test("line-ending convention is part of the entry rule and is stable", () => {
  const lf = bridgeSpendLedger([LINE_1 + "\n", LINE_2], INTACT);
  const crlf = bridgeSpendLedger([LINE_1 + "\r\n", LINE_2], INTACT);
  const bare = bridgeSpendLedger([LINE_1, LINE_2], INTACT);
  assert.equal(lf.rootHex, crlf.rootHex);
  assert.equal(lf.rootHex, bare.rootHex);
});

test("bridge refuses an unverified or broken chain report, fail closed", () => {
  for (const bad of [undefined, null, {}, { ok: false }, { ok: 1 }, BROKEN]) {
    assert.throws(() => bridgeSpendLedger([LINE_1], bad as never), /not intact/);
  }
  assert.throws(() => assertChainIntact(BROKEN), /not intact/);
});

test("root is 32 bytes and leaves are hex and in ledger order", () => {
  const out = bridgeSpendLedger([LINE_1, LINE_2, LINE_3], INTACT);
  assert.equal(out.root.length, 32);
  assert.equal(out.rootHex, hex(out.root));
  assert.equal(out.leaves.length, 3);
  assert.equal(out.leaves[0], hex(leafHash(lineToEntryBytes(LINE_1))));
  assert.equal(out.leaves[1], hex(leafHash(lineToEntryBytes(LINE_2))));
  assert.equal(out.sthDomain, "TWZRD:RECEIPT_LOG_STH_V1");
});
