import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { genesisHash, chainAppend, canonicalJSON } from "../dist/ledger/chain.js";
import { verifyChain } from "../dist/ledger/verify.js";
import { merkleRoot, batchRoot, verifyInclusion, inclusionProof } from "../dist/ledger/merkle.js";

describe("ledger chain", () => {
  it("genesis is deterministic and canonical ordering works", () => {
    const a = genesisHash();
    const b = genesisHash();
    assert.equal(a, b);
    assert.equal(canonicalJSON({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it("chain of three entries verifies", () => {
    let prev = genesisHash();
    const e0 = chainAppend({ sequence: 0, timestamp: "2026-11-11T00:00:00.000Z", event_type: "gate_refusal", payload: { code: "evidence_missing" } }, prev);
    prev = e0.entry_hash;
    const e1 = chainAppend({ sequence: 1, timestamp: "2026-11-11T00:01:00.000Z", event_type: "spend", payload: { amount: 100 } }, prev);
    prev = e1.entry_hash;
    const e2 = chainAppend({ sequence: 2, timestamp: "2026-11-11T00:02:00.000Z", event_type: "gate_refusal", payload: { code: "approval_missing" } }, prev);
    const r = verifyChain([e0, e1, e2]);
    assert.equal(r.ok, true);
    assert.equal(r.count, 3);
    assert.equal(r.finalHash, e2.entry_hash);
  });

  it("tamper breaks entry_hash", () => {
    let prev = genesisHash();
    const e0 = chainAppend({ sequence: 0, timestamp: "2026-11-11T00:00:00.000Z", event_type: "spend", payload: { amount: 100 } }, prev);
    const tampered = { ...e0, payload: { amount: 999 } };
    const r = verifyChain([tampered]);
    assert.equal(r.ok, false);
    assert.equal(r.brokenAt, 0);
  });

  it("missing row breaks sequence/prev_hash", () => {
    let prev = genesisHash();
    const e0 = chainAppend({ sequence: 0, timestamp: "2026-11-11T00:00:00.000Z", event_type: "spend", payload: {} }, prev);
    prev = e0.entry_hash;
    const e2 = chainAppend({ sequence: 2, timestamp: "2026-11-11T00:02:00.000Z", event_type: "spend", payload: {} }, prev);
    // e2 was built with prev=e0.hash but sequence 2 skips 1
    const r = verifyChain([e0, e2]);
    assert.equal(r.ok, false);
  });

  it("reordering is detected", () => {
    let prev = genesisHash();
    const e0 = chainAppend({ sequence: 0, timestamp: "2026-11-11T00:00:00.000Z", event_type: "a", payload: {} }, prev);
    prev = e0.entry_hash;
    const e1 = chainAppend({ sequence: 1, timestamp: "2026-11-11T00:01:00.000Z", event_type: "b", payload: {} }, prev);
    const r = verifyChain([e1, e0]);
    assert.equal(r.ok, false);
  });

  it("merkle root is stable and verifies inclusion", () => {
    const leaves = [genesisHash(), genesisHash(), genesisHash()];
    const root1 = merkleRoot(leaves);
    const root2 = merkleRoot([...leaves]);
    assert.equal(root1, root2);
    const proof = inclusionProof(leaves, 1);
    assert.equal(verifyInclusion(leaves[1]!, 1, proof, root1), true);
    const batch = batchRoot([{ entry_hash: leaves[0]! }, { entry_hash: leaves[1]! }]);
    assert.equal(typeof batch, "string");
  });
});
