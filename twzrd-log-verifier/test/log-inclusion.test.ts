import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { verifyLogInclusion, type LogInclusionBlock } from "../src/client.js";
import { DEFAULT_STH_PUBKEY } from "../src/index.js";
import { STH_DOMAIN_V2, signSth } from "../src/sth.js";
import { merkleRoot, inclusionProof } from "../src/merkle.js";
import { b58encode, bytesToHex } from "../src/util.js";

// The live log's genesis head as served by https://intel.twzrd.xyz/v1/log/sth
// (2026-09-04) and the one leaf it commits to — what a paid /v1/intel/trust
// response carries as `log_inclusion`. Real data, not a fixture we minted: if
// this stops verifying, the pinned key changed or history was rewritten.
const LIVE_LEAF = "0xf7e88f2666a0590d8cf7d426d4842e29a23b66607f2c0a691bf6fc7d0d63ba8f";
const LIVE_BLOCK: LogInclusionBlock = {
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
    signing_pubkey: DEFAULT_STH_PUBKEY,
  },
  anchor: null,
  verify: `/v1/log/proof/inclusion?leaf=${LIVE_LEAF}`,
};
const paid = { twzrd_receipt: { leaf: LIVE_LEAF }, log_inclusion: LIVE_BLOCK };

test("live genesis head: the block a paid response carries verifies offline against the built-in pin", () => {
  const res = verifyLogInclusion(paid, DEFAULT_STH_PUBKEY);
  assert.deepEqual(res.errors, []);
  assert.equal(res.valid, true);
  assert.equal(res.tofu, false);
  assert.equal(res.leaf_index, 0);
  assert.equal(res.tree_size, 1);
  assert.equal(verifyLogInclusion(LIVE_BLOCK, DEFAULT_STH_PUBKEY).valid, true, "bare block");
  const bare = { ...LIVE_BLOCK, leaf: undefined };
  assert.equal(verifyLogInclusion(bare, DEFAULT_STH_PUBKEY, { leaf: LIVE_LEAF }).valid, true, "bare proof + opts.leaf");
});

test("a proof for a different leaf attached to your receipt is rejected before any signature work", () => {
  const other = "0x" + "ab".repeat(32);
  const res = verifyLogInclusion({ twzrd_receipt: { leaf: other }, log_inclusion: LIVE_BLOCK }, DEFAULT_STH_PUBKEY);
  assert.equal(res.valid, false);
  assert.match(res.errors.join("\n"), /leaf mismatch/);
  assert.equal(res.sth_valid, false);
});

test("a receipt that names no valid leaf is rejected even beside a block that verifies", () => {
  const cases: Array<[string, unknown]> = [
    ["no leaf", { preimage: { settlement_tx: "TX" } }],
    ["empty leaf", { leaf: "" }],
    ["short leaf", { leaf: "0xabcd" }],
    ["non-hex leaf", { leaf: "0x" + "zz".repeat(32) }],
    ["null receipt", null],
    ["string receipt", LIVE_LEAF],
    ["array receipt", [{ leaf: LIVE_LEAF }]],
  ];
  for (const [label, twzrd_receipt] of cases) {
    const res = verifyLogInclusion({ twzrd_receipt, log_inclusion: LIVE_BLOCK }, DEFAULT_STH_PUBKEY);
    assert.equal(res.valid, false, label);
    assert.match(res.errors.join("\n"), /receipt has no 64-hex-char \.leaf/, label);
    assert.equal(res.sth_valid, false, `${label}: rejected before any signature work`);
    const withCallerLeaf = verifyLogInclusion({ twzrd_receipt, log_inclusion: LIVE_BLOCK }, DEFAULT_STH_PUBKEY, {
      leaf: LIVE_LEAF,
    });
    assert.equal(withCallerLeaf.valid, false, `${label}: opts.leaf does not stand in for the receipt's own leaf`);
  }
  // Unchanged: an uppercase or 0x-less leaf still names the same leaf.
  const upper = verifyLogInclusion(
    { twzrd_receipt: { leaf: LIVE_LEAF.slice(2).toUpperCase() }, log_inclusion: LIVE_BLOCK },
    DEFAULT_STH_PUBKEY,
  );
  assert.equal(upper.valid, true, upper.errors.join("; "));
});

test("a leaf that is not a string is refused wherever it is named, never converted", () => {
  // String(["0x.."]) prints the array's one element. While leaves were read
  // through String(), the first three of these verified as the proven leaf.
  const notStrings: Array<[string, unknown]> = [
    ["array holding the leaf", [LIVE_LEAF]],
    ["nested array holding the leaf", [[LIVE_LEAF]]],
    ["object that prints as the leaf", { toString: () => LIVE_LEAF }],
    ["plain object", { hex: LIVE_LEAF }],
    ["number", 12345],
    ["zero", 0],
    ["boolean", true],
    ["false", false],
  ];
  const bareProof = { ...LIVE_BLOCK, leaf: undefined };
  for (const [label, leaf] of notStrings) {
    // A type error that says where, in all four places: `0` and `false` are
    // leaves someone wrote down, not a missing leaf.
    const asReceipt = verifyLogInclusion({ twzrd_receipt: { leaf }, log_inclusion: LIVE_BLOCK }, DEFAULT_STH_PUBKEY);
    assert.equal(asReceipt.valid, false, `receipt leaf, ${label}`);
    assert.deepEqual(asReceipt.errors, ["twzrd_receipt.leaf: leaf must be a string of 64 hex chars"], `receipt leaf, ${label}`);
    assert.equal(asReceipt.sth_valid, false, `receipt leaf, ${label}: rejected before any signature work`);

    const asBareBlock = verifyLogInclusion({ ...LIVE_BLOCK, leaf }, DEFAULT_STH_PUBKEY);
    assert.equal(asBareBlock.valid, false, `bare block leaf, ${label}`);
    assert.deepEqual(asBareBlock.errors, ["leaf: leaf must be a string of 64 hex chars"], `bare block leaf, ${label}`);
    assert.equal(asBareBlock.sth_valid, false, `bare block leaf, ${label}: rejected before any signature work`);

    const asInnerBlock = verifyLogInclusion(
      { twzrd_receipt: { leaf: LIVE_LEAF }, log_inclusion: { ...LIVE_BLOCK, leaf } },
      DEFAULT_STH_PUBKEY,
    );
    assert.equal(asInnerBlock.valid, false, `log_inclusion.leaf, ${label}`);
    assert.deepEqual(asInnerBlock.errors, ["log_inclusion.leaf: leaf must be a string of 64 hex chars"], label);

    const asCaller = verifyLogInclusion(bareProof, DEFAULT_STH_PUBKEY, { leaf: leaf as string });
    assert.equal(asCaller.valid, false, `opts.leaf, ${label}`);
    assert.deepEqual(asCaller.errors, ["opts.leaf: leaf must be a string of 64 hex chars"], `opts.leaf, ${label}`);

    // A string leaf named somewhere else does not make up for it.
    assert.equal(
      verifyLogInclusion({ ...LIVE_BLOCK, leaf }, DEFAULT_STH_PUBKEY, { leaf: LIVE_LEAF }).valid,
      false,
      `bare block leaf, ${label}: opts.leaf does not stand in for it`,
    );
  }

  // Unchanged: a bare block, a bare proof with opts.leaf, and a leaf written in
  // upper case or without 0x, in each of the three places a leaf is named.
  const upper = LIVE_LEAF.slice(2).toUpperCase();
  assert.equal(verifyLogInclusion(LIVE_BLOCK, DEFAULT_STH_PUBKEY).valid, true, "bare block");
  assert.equal(verifyLogInclusion({ ...LIVE_BLOCK, leaf: upper }, DEFAULT_STH_PUBKEY).valid, true, "bare block, upper case");
  assert.equal(verifyLogInclusion(bareProof, DEFAULT_STH_PUBKEY, { leaf: LIVE_LEAF }).valid, true, "bare proof + opts.leaf");
  assert.equal(verifyLogInclusion(bareProof, DEFAULT_STH_PUBKEY, { leaf: upper }).valid, true, "bare proof + upper-case opts.leaf");
  assert.equal(
    verifyLogInclusion({ twzrd_receipt: { leaf: upper }, log_inclusion: { ...LIVE_BLOCK, leaf: upper } }, DEFAULT_STH_PUBKEY).valid,
    true,
    "paid response, upper case, no 0x",
  );
  // Unchanged: a block whose leaf is null or empty names nothing; opts.leaf names it.
  for (const blank of [null, ""]) {
    const res = verifyLogInclusion({ ...LIVE_BLOCK, leaf: blank }, DEFAULT_STH_PUBKEY, { leaf: LIVE_LEAF });
    assert.equal(res.valid, true, `block leaf ${JSON.stringify(blank)} + opts.leaf: ${res.errors.join("; ")}`);
  }
  // Unchanged: a receipt whose leaf is missing, null or empty is the missing-leaf error.
  for (const blank of [undefined, null, ""]) {
    const res = verifyLogInclusion({ twzrd_receipt: { leaf: blank }, log_inclusion: LIVE_BLOCK }, DEFAULT_STH_PUBKEY);
    assert.equal(res.valid, false, `receipt leaf ${JSON.stringify(blank)}`);
    assert.match(res.errors.join("\n"), /^receipt has no 64-hex-char \.leaf/, `receipt leaf ${JSON.stringify(blank)}`);
  }
  // Every wrong-typed leaf in a document is reported, in a fixed order.
  const three = verifyLogInclusion(
    { twzrd_receipt: { leaf: 0 }, log_inclusion: { ...LIVE_BLOCK, leaf: false } },
    DEFAULT_STH_PUBKEY,
    { leaf: [LIVE_LEAF] as unknown as string },
  );
  assert.deepEqual(three.errors, [
    "opts.leaf: leaf must be a string of 64 hex chars",
    "twzrd_receipt.leaf: leaf must be a string of 64 hex chars",
    "log_inclusion.leaf: leaf must be a string of 64 hex chars",
  ]);
});

test("tampered root, wrong pin, missing head, missing leaf, missing index each fail by name", () => {
  const root = LIVE_BLOCK.sth.root;
  const tampered = { ...LIVE_BLOCK, sth: { ...LIVE_BLOCK.sth, root: root.slice(0, -1) + (root.endsWith("0") ? "1" : "0") } };
  const t = verifyLogInclusion(tampered, DEFAULT_STH_PUBKEY);
  assert.equal(t.valid, false);
  assert.equal(t.sth_valid, false);
  assert.equal(verifyLogInclusion(LIVE_BLOCK, b58encode(nacl.sign.keyPair().publicKey)).sth_valid, false);
  assert.match(verifyLogInclusion({ ...LIVE_BLOCK, sth: undefined }, DEFAULT_STH_PUBKEY).errors.join("\n"), /no sth/);
  assert.match(verifyLogInclusion({ ...LIVE_BLOCK, leaf: undefined }, DEFAULT_STH_PUBKEY).errors.join("\n"), /no leaf/);
  const noIndex = verifyLogInclusion({ ...LIVE_BLOCK, leaf_index: undefined }, DEFAULT_STH_PUBKEY);
  assert.equal(noIndex.valid, false, "a block with no leaf_index must not verify by accident");
  assert.match(noIndex.errors.join("\n"), /leaf_index/);
});

test("non-degenerate path: a V2 head over 40 leaves at index 17 goes through the same code path", () => {
  const kp = nacl.sign.keyPair();
  const pin = b58encode(kp.publicKey);
  const entries = Array.from({ length: 40 }, (_, i) =>
    Uint8Array.from({ length: 32 }, (_, j) => (i * 17 + j * 5 + 2) & 0xff),
  );
  const sth = signSth(
    { domain: STH_DOMAIN_V2, log_id: "t", key_id: "k1", tree_size: 40, timestamp_unix: 1, root: bytesToHex(merkleRoot(entries)) },
    kp.secretKey,
  );
  const path = inclusionProof(entries, 17).map(bytesToHex);
  const block = { leaf: bytesToHex(entries[17]), leaf_index: 17, tree_size: 40, audit_path: path, sth };
  const ok = verifyLogInclusion(block, pin);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.valid, true);
  assert.equal(ok.key_id, "k1");
  const swapped = verifyLogInclusion({ ...block, audit_path: [path[1], path[0], ...path.slice(2)] }, pin);
  assert.equal(swapped.sth_valid, true);
  assert.equal(swapped.inclusion_valid, false);
  assert.match(verifyLogInclusion({ ...block, tree_size: 39 }, pin).errors.join("\n"), /proof targets tree_size 39/);
});

test("an audit_path entry that is not a string is refused, never converted", () => {
  const kp = nacl.sign.keyPair();
  const pin = b58encode(kp.publicKey);
  const entries = Array.from({ length: 40 }, (_, i) =>
    Uint8Array.from({ length: 32 }, (_, j) => (i * 17 + j * 5 + 2) & 0xff),
  );
  const sth = signSth(
    { domain: STH_DOMAIN_V2, log_id: "t", key_id: "k1", tree_size: 40, timestamp_unix: 1, root: bytesToHex(merkleRoot(entries)) },
    kp.secretKey,
  );
  const path = inclusionProof(entries, 17).map(bytesToHex);
  const block = { leaf: bytesToHex(entries[17]), leaf_index: 17, tree_size: 40, audit_path: path as unknown[], sth };
  assert.equal(verifyLogInclusion(block, pin).valid, true, "the proof itself verifies");
  assert.ok(path.length >= 5);

  // While entries were read through String(), the first three shapes verified:
  // each prints as the hash it wraps.
  const wraps: Array<[string, (h: string) => unknown]> = [
    ["array holding the hash", (h) => [h]],
    ["nested array holding the hash", (h) => [[h]]],
    ["object that prints as the hash", (h) => ({ toString: () => h })],
    ["plain object", (h) => ({ hex: h })],
    ["number", () => 12345],
    ["zero", () => 0],
    ["false", () => false],
    ["true", () => true],
    ["null", () => null],
  ];
  for (const [label, wrap] of wraps) {
    for (const i of [0, 2, path.length - 1]) {
      const audit_path = path.map((h, j) => (j === i ? wrap(h) : h));
      const res = verifyLogInclusion({ ...block, audit_path }, pin);
      assert.equal(res.valid, false, `${label} at ${i}`);
      assert.equal(res.inclusion_valid, false, `${label} at ${i}`);
      assert.deepEqual(res.errors, [`audit path: audit_path[${i}] must be a hex string`], `${label} at ${i}`);
      // Same refusal inside a whole paid response.
      const paidDoc = { twzrd_receipt: { leaf: block.leaf }, log_inclusion: { ...block, audit_path } };
      assert.deepEqual(verifyLogInclusion(paidDoc, pin).errors, [`audit path: audit_path[${i}] must be a hex string`], label);
    }
  }

  // The path itself is an array. A value of another type is refused, an
  // explicit 0, false or "" included; only a missing or null path is empty.
  const notArrays: Array<[string, unknown]> = [
    ["one string of all the hashes", path.join("")],
    ["array-like object", { ...path, length: path.length }],
    ["zero", 0],
    ["false", false],
    ["empty string", ""],
  ];
  for (const [label, audit_path] of notArrays) {
    const res = verifyLogInclusion({ ...block, audit_path }, pin);
    assert.equal(res.valid, false, label);
    assert.deepEqual(res.errors, ["audit path: audit_path must be an array of hex strings"], label);
    const onGenesis = verifyLogInclusion({ ...LIVE_BLOCK, audit_path }, DEFAULT_STH_PUBKEY);
    assert.equal(onGenesis.valid, false, `${label}: not read as the empty path of a one-leaf tree`);
  }

  // Unchanged: a missing or null path is the empty path (a one-leaf tree), and
  // an entry is hex in either case, with or without 0x.
  for (const blank of [undefined, null]) {
    const res = verifyLogInclusion({ ...LIVE_BLOCK, audit_path: blank }, DEFAULT_STH_PUBKEY);
    assert.equal(res.valid, true, `audit_path ${JSON.stringify(blank)}: ${res.errors.join("; ")}`);
    assert.equal(verifyLogInclusion({ ...block, audit_path: blank }, pin).valid, false, "an empty path proves nothing in a 40-leaf tree");
  }
  const respelled = path.map((h, j) => (j % 2 === 0 ? "0x" + h.toUpperCase() : h.toUpperCase()));
  assert.equal(verifyLogInclusion({ ...block, audit_path: respelled }, pin).valid, true);
  // Unchanged: a string that is not hex is still the hex error.
  const notHex = verifyLogInclusion({ ...block, audit_path: ["zz", ...path.slice(1)] }, pin);
  assert.match(notHex.errors.join("\n"), /^audit path: invalid hex string/);
});
