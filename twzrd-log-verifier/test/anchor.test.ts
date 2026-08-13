import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import {
  ANCHOR_MEMO_PREFIX,
  parseAnchorMemo,
  formatAnchorMemo,
  anchorMatchesSth,
  verifyAnchor,
} from "../src/anchor.js";
import { STH_DOMAIN, signSth } from "../src/sth.js";
import { b58encode, bytesToHex } from "../src/util.js";
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
