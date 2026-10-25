import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import {
  ANCHOR_MEMO_PREFIX,
  ANCHOR_HEAD_DISCRIMINATOR,
  EVIDENCE_LEDGER_PROGRAM_ID,
  parseAnchorMemo,
  parseAnchorHeadData,
  formatAnchorMemo,
  anchorMatchesSth,
  verifyAnchor,
} from "../src/anchor.js";
import { STH_DOMAIN, signSth } from "../src/sth.js";
import { b58encode, bytesToHex, concatBytes, hexToBytes, u64le } from "../src/util.js";
import { merkleRoot } from "../src/merkle.js";

const kp = nacl.sign.keyPair();
const pub = b58encode(kp.publicKey);
const AUTHORITY = "4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE";

const root = bytesToHex(merkleRoot([new Uint8Array(32)]));
const sth = signSth(
  {
    domain: STH_DOMAIN,
    log_id: "intel.twzrd.xyz/v6",
    tree_size: 42,
    timestamp_unix: 1755072000,
    root,
  },
  kp.secretKey,
);
const memo = formatAnchorMemo({ log_id: "intel.twzrd.xyz/v6", tree_size: 42, root });

function mockRpc(result: unknown) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
  });
}

function txResult(opts: { memos?: string[]; signers?: string[] }) {
  return {
    slot: 355000000,
    blockTime: 1755072100,
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: (opts.signers ?? [AUTHORITY]).map((pubkey) => ({ pubkey, signer: true })),
        instructions: (opts.memos ?? [memo]).map((m) => ({
          program: "spl-memo",
          programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
          parsed: m,
        })),
      },
    },
  };
}

test("anchor memo round trip, including a log_id containing colons", () => {
  const p = parseAnchorMemo(memo);
  assert.ok(p);
  assert.equal(p.log_id, "intel.twzrd.xyz/v6");
  assert.equal(p.tree_size, 42);
  assert.equal(p.root, root.replace(/^0x/, ""));

  const weird = formatAnchorMemo({ log_id: "a:b:c/v1", tree_size: 7, root });
  const wp = parseAnchorMemo(weird);
  assert.ok(wp);
  assert.equal(wp.log_id, "a:b:c/v1");
  assert.equal(wp.tree_size, 7);
});

test("malformed memos parse to null", () => {
  assert.equal(parseAnchorMemo("hello"), null);
  assert.equal(parseAnchorMemo(ANCHOR_MEMO_PREFIX), null);
  assert.equal(parseAnchorMemo(`${ANCHOR_MEMO_PREFIX}log:notanumber:${"ab".repeat(32)}`), null);
  assert.equal(parseAnchorMemo(`${ANCHOR_MEMO_PREFIX}log:42:tooshort`), null);
  assert.equal(parseAnchorMemo(`${ANCHOR_MEMO_PREFIX}:42:${"ab".repeat(32)}`), null);
});

test("anchorMatchesSth flags every field mismatch", () => {
  const good = parseAnchorMemo(memo)!;
  assert.deepEqual(anchorMatchesSth(good, sth), []);
  assert.equal(anchorMatchesSth({ ...good, tree_size: 43 }, sth).length, 1);
  assert.equal(anchorMatchesSth({ ...good, log_id: "other" }, sth).length, 1);
  assert.equal(anchorMatchesSth({ ...good, root: "ab".repeat(32) }, sth).length, 1);
});

test("verifyAnchor: happy path", async () => {
  const res = await verifyAnchor({
    sth,
    txSignature: "x".repeat(87),
    sthPubkey: pub,
    anchorAuthority: AUTHORITY,
    fetchImpl: mockRpc(txResult({})),
  });
  assert.deepEqual(res.errors, []);
  assert.ok(res.valid);
  assert.equal(res.slot, 355000000);
  assert.equal(res.block_time, 1755072100);
});

test("verifyAnchor: authority not a signer fails", async () => {
  const res = await verifyAnchor({
    sth,
    txSignature: "x".repeat(87),
    sthPubkey: pub,
    anchorAuthority: AUTHORITY,
    fetchImpl: mockRpc(txResult({ signers: ["SomeOtherWallet1111111111111111111111111111"] })),
  });
  assert.ok(!res.valid);
  assert.ok(!res.authority_signed);
});

test("verifyAnchor: memo for a different head fails", async () => {
  const otherMemo = formatAnchorMemo({ log_id: "intel.twzrd.xyz/v6", tree_size: 41, root });
  const res = await verifyAnchor({
    sth,
    txSignature: "x".repeat(87),
    sthPubkey: pub,
    anchorAuthority: AUTHORITY,
    fetchImpl: mockRpc(txResult({ memos: [otherMemo] })),
  });
  assert.ok(!res.valid);
  assert.ok(!res.memo_found);
});

test("verifyAnchor: missing tx and RPC errors are reported, not thrown", async () => {
  const notFound = await verifyAnchor({
    sth,
    txSignature: "x".repeat(87),
    sthPubkey: pub,
    anchorAuthority: AUTHORITY,
    fetchImpl: mockRpc(null),
  });
  assert.ok(!notFound.valid);
  assert.match(notFound.errors.join(" "), /not found/);

  const httpErr = await verifyAnchor({
    sth,
    txSignature: "x".repeat(87),
    sthPubkey: pub,
    anchorAuthority: AUTHORITY,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.ok(!httpErr.valid);
  assert.match(httpErr.errors.join(" "), /HTTP 500/);
});

test("verifyAnchor: invalid STH signature fails even with a matching memo", async () => {
  const res = await verifyAnchor({
    sth: { ...sth, tree_size: 43 }, // breaks the signature; memo also mismatches
    txSignature: "x".repeat(87),
    sthPubkey: pub,
    anchorAuthority: AUTHORITY,
    fetchImpl: mockRpc(txResult({})),
  });
  assert.ok(!res.valid);
  assert.ok(!res.sth_valid);
});

// --- program form: the evidence-ledger anchor_head instruction --------------

const LEDGER = "8EpPmDkQQ9uqMQH166kx7nu4wT415bobWcWfyiZDvgv3";
const ROOT_ENTRY = "CKzEZNiNcJLqvwoCoVATtqufedxi67DXosFr2R6caP7f";
const SYSTEM = "11111111111111111111111111111111";
const IX_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
const ED25519 = "Ed25519SigVerify111111111111111111111111111";

/** The program's layout (programs/evidence-ledger, anchor.rs), built independently of the parser. */
function anchorHeadData(h: { log_id: string; tree_size: number; timestamp_unix: number; root: string }) {
  const lid = new TextEncoder().encode(h.log_id);
  return concatBytes(
    ANCHOR_HEAD_DISCRIMINATOR,
    u64le(h.tree_size),
    u64le(h.timestamp_unix),
    hexToBytes(h.root),
    Uint8Array.of(lid.length),
    lid,
  );
}

/** A getTransaction(jsonParsed) result shaped like a landed anchor: the precompile, then anchor_head. */
function headTx(opts: {
  data?: Uint8Array;
  programId?: string;
  accounts?: string[];
  signers?: string[];
  err?: unknown;
} = {}) {
  const accounts = opts.accounts ?? [AUTHORITY, AUTHORITY, LEDGER, ROOT_ENTRY, SYSTEM, IX_SYSVAR];
  const signers = opts.signers ?? [AUTHORITY];
  return {
    slot: 460944409,
    blockTime: 1755072100,
    meta: { err: opts.err ?? null },
    transaction: {
      message: {
        accountKeys: [
          ...signers.map((pubkey) => ({ pubkey, signer: true })),
          ...[LEDGER, ROOT_ENTRY, SYSTEM, ED25519, IX_SYSVAR].map((pubkey) => ({ pubkey, signer: false })),
        ],
        instructions: [
          { accounts: [], data: b58encode(new Uint8Array(16)), programId: ED25519, stackHeight: 1 },
          {
            accounts,
            data: b58encode(opts.data ?? anchorHeadData(sth)),
            programId: opts.programId ?? EVIDENCE_LEDGER_PROGRAM_ID,
            stackHeight: 1,
          },
        ],
      },
    },
  };
}

function verifyHead(result: unknown, extra: { ledger?: string; anchorProgramId?: string } = {}) {
  return verifyAnchor({
    sth,
    txSignature: "x".repeat(87),
    sthPubkey: pub,
    anchorAuthority: AUTHORITY,
    fetchImpl: mockRpc(result),
    ...extra,
  });
}

test("anchor_head discriminator is sha256('global:anchor_head')[0..8]", () => {
  const want = createHash("sha256").update("global:anchor_head").digest().subarray(0, 8);
  assert.equal(bytesToHex(ANCHOR_HEAD_DISCRIMINATOR), bytesToHex(want));
});

test("anchor_head data decodes the bytes the TWZRD anchor job builds", () => {
  // Built by the anchor job's Python builder (log_anchor_publisher.anchor_head_ix) for a
  // synthetic head: log_id intel.twzrd.xyz/v6, tree_size 42, timestamp 1755072000, root 00..1f.
  const fromPython = hexToBytes(
    "6dab203dc598eb712a0000000000000000469c6800000000000102030405060708090a0b0c0d0e0f" +
      "101112131415161718191a1b1c1d1e1f12696e74656c2e74777a72642e78797a2f7636",
  );
  const want = { log_id: "intel.twzrd.xyz/v6", tree_size: 42, timestamp_unix: 1755072000, root: bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => i)) };
  assert.deepEqual(parseAnchorHeadData(fromPython), want);
  assert.deepEqual(anchorHeadData(want), fromPython);
});

test("anchor_head data that is not exactly one head parses to null", () => {
  const good = anchorHeadData(sth);
  const at = (i: number, v: number) => Uint8Array.from(good, (b, j) => (j === i ? v : b));
  const u64max = concatBytes(good.subarray(0, 8), new Uint8Array(8).fill(0xff), good.subarray(16));
  assert.ok(parseAnchorHeadData(good));
  assert.equal(parseAnchorHeadData(at(0, good[0] ^ 1)), null); // another instruction
  assert.equal(parseAnchorHeadData(concatBytes(good, Uint8Array.of(0))), null); // trailing byte
  assert.equal(parseAnchorHeadData(good.subarray(0, good.length - 1)), null); // truncated log_id
  assert.equal(parseAnchorHeadData(at(56, 0)), null); // empty log_id
  assert.equal(parseAnchorHeadData(concatBytes(good.subarray(0, 8), u64le(0), good.subarray(16))), null); // size 0
  assert.equal(parseAnchorHeadData(u64max), null); // beyond Number.MAX_SAFE_INTEGER
  assert.equal(parseAnchorHeadData(at(57, 0xff)), null); // not UTF-8
  const long = anchorHeadData({ ...sth, log_id: "x".repeat(65) } as never);
  assert.equal(parseAnchorHeadData(long), null); // longer than the program accepts
});

test("verifyAnchor: a landed anchor_head of the pinned program verifies", async () => {
  const res = await verifyHead(headTx(), { ledger: LEDGER });
  assert.deepEqual(res.errors, []);
  assert.ok(res.valid);
  assert.equal(res.anchor_kind, "anchor_head");
  assert.ok(res.anchor_head_found && res.tx_succeeded && res.authority_signed && !res.memo_found);
  assert.equal(res.slot, 460944409);
});

test("verifyAnchor: a failed anchor transaction anchors nothing", async () => {
  const res = await verifyHead(headTx({ err: { InstructionError: [1, { Custom: 6 }] } }));
  assert.ok(!res.valid);
  assert.ok(!res.tx_succeeded && res.anchor_head_found);
  assert.match(res.errors.join(" "), /failed/);
  const noMeta = await verifyHead({ ...headTx(), meta: null });
  assert.ok(!noMeta.valid && !noMeta.tx_succeeded);
});

test("verifyAnchor: the same bytes from another program prove nothing", async () => {
  const res = await verifyHead(headTx({ programId: "11111111111111111111111111111112" }));
  assert.ok(!res.valid);
  assert.equal(res.anchor_kind, null);
  assert.match(res.errors.join(" "), /no anchor_head instruction of Bz/);
  const pinnedElsewhere = await verifyHead(headTx(), { anchorProgramId: "11111111111111111111111111111112" });
  assert.ok(!pinnedElsewhere.valid);
});

test("verifyAnchor: the authority must be the instruction's authority, not only a signer", async () => {
  const other = "SomeOtherWallet1111111111111111111111111111";
  const res = await verifyHead(
    headTx({ accounts: [other, AUTHORITY, LEDGER, ROOT_ENTRY, SYSTEM, IX_SYSVAR], signers: [AUTHORITY, other] }),
  );
  assert.ok(res.authority_signed);
  assert.ok(!res.valid && !res.anchor_head_found);
  assert.match(res.errors.join(" "), /anchor_head authority/);
});

test("verifyAnchor: a ledger pin rejects another ledger account", async () => {
  const res = await verifyHead(headTx(), { ledger: "11111111111111111111111111111112" });
  assert.ok(!res.valid);
  assert.match(res.errors.join(" "), /pinned ledger/);
});

test("verifyAnchor: an anchor_head for another head fails on every field", async () => {
  for (const changed of [
    { tree_size: 41 },
    { timestamp_unix: Number(sth.timestamp_unix) + 1 },
    { root: "ab".repeat(32) },
    { log_id: "intel.twzrd.xyz/v7" },
  ]) {
    const res = await verifyHead(headTx({ data: anchorHeadData({ ...sth, ...changed } as never) }));
    assert.ok(!res.valid, JSON.stringify(changed));
    assert.ok(!res.anchor_head_found);
  }
});

test("verifyAnchor: a memo anchor in a failed transaction no longer verifies", async () => {
  const res = await verifyHead({ ...txResult({}), meta: { err: { InstructionError: [0, "Custom"] } } });
  assert.ok(!res.valid);
  assert.ok(res.memo_found && !res.tx_succeeded);
  assert.equal(res.anchor_kind, "memo");
});
