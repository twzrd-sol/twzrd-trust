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
