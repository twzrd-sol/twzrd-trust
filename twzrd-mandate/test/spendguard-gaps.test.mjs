// Spendguard gaps: cross-call purchase dedupe and the trust-screen off mode.
// Every refusal here is checked three ways: the code, the payer's signature
// count, and what the seller actually received.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  PURCHASE_DEDUPE_WINDOW_MS,
  STATE_FILES,
  purchaseDedupeKey,
  reservePurchase,
} from "../dist/index.js";
import { makeRig } from "./helpers.mjs";

function ledgerLines(rig) {
  const file = path.join(rig.stateDir, STATE_FILES.decisionLedger);
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("the same purchase twice signs once: the retry is refused as duplicate_purchase", async () => {
  const rig = await makeRig();
  try {
    const first = await rig.buy("x");
    assert.equal(first.outcome, "settled", first.record.detail);
    assert.equal(first.signatures, 1);
    const paidAfterFirst = rig.world.paidCount;
    assert.equal(paidAfterFirst, 1);

    const second = await rig.buy("x");
    assert.equal(second.outcome, "refused", second.record.detail);
    assert.equal(second.refusal.code, "duplicate_purchase");
    assert.equal(second.refusal.layer, 4);
    assert.equal(second.signatures, 0);
    assert.equal(rig.payer.signatures, 1, "the payer signed twice");
    assert.equal(rig.world.paidCount, paidAfterFirst, "the seller was paid twice");
    const doc = JSON.parse(Buffer.from(second.body).toString("utf8"));
    assert.equal(doc.error.code, "duplicate_purchase");
  } finally {
    await rig.close();
  }
});

test("a different body is a different purchase and settles", async () => {
  const rig = await makeRig();
  try {
    assert.equal((await rig.buy("x")).outcome, "settled");
    const other = await rig.runtime.call({
      tool: rig.tool,
      url: rig.world.url("x"),
      method: "POST",
      body: Buffer.from('{"different":true}'),
    });
    assert.equal(other.outcome, "settled", other.record.detail);
    assert.equal(other.signatures, 1);
    assert.equal(rig.world.paidCount, 2);
  } finally {
    await rig.close();
  }
});

test("the dedupe key is stable, case-insensitive on payTo, and expires past the window", async () => {
  const parts = {
    method: "POST",
    url: "https://seller.example/v1/chat",
    bodyHash: "ab".repeat(32),
    payTo: "0xB36e83aB5E6128bC0E1b76b3F59Fe2fD443F0788",
    amountMicro: 1000n,
    network: "eip155:8453",
  };
  assert.equal(purchaseDedupeKey(parts), purchaseDedupeKey(parts));
  assert.equal(
    purchaseDedupeKey(parts),
    purchaseDedupeKey({ ...parts, payTo: "0xb36e83ab5e6128bc0e1b76b3f59fe2fd443f0788" }),
  );
  assert.notEqual(purchaseDedupeKey(parts), purchaseDedupeKey({ ...parts, amountMicro: 1001n }));

  const dir = fs.mkdtempSync(path.join(process.cwd(), "dedupe-test-"));
  const key = purchaseDedupeKey(parts);
  assert.equal(reservePurchase(dir, key, 1_000_000), true);
  assert.equal(reservePurchase(dir, key, 1_000_000 + PURCHASE_DEDUPE_WINDOW_MS - 1), false);
  assert.equal(reservePurchase(dir, key, 1_000_000 + PURCHASE_DEDUPE_WINDOW_MS), true, "the window rolls over");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("trustScreen off: the payment proceeds with the preflight down, and the ledger says so", async () => {
  const rig = await makeRig({ mandate: { trustScreen: "off" } });
  try {
    rig.world.trustDown = true;
    rig.world.defaultTrust = { decision: "block", score: 5, washFlagged: false };
    const result = await rig.buy("ok");
    assert.equal(result.outcome, "settled", result.record.detail);
    assert.equal(result.signatures, 1);
    const control = ledgerLines(rig).filter((r) => r.outcome === "control" && r.code === "trust_screen_off");
    assert.equal(control.length, 1, "one trust_screen_off control line per payment");
    assert.equal(control[0].signatures, 0);
  } finally {
    await rig.close();
  }
});

test("trustScreen off skips the preflight lookup, but an explicitly wash-flagged seller still refuses", async () => {
  const rig = await makeRig({ mandate: { trustScreen: "off", minTrustScore: 100 } });
  try {
    // A block verdict without a wash flag proceeds: off means unevaluated is accepted.
    rig.world.defaultTrust = { decision: "block", score: 0, washFlagged: false };
    assert.equal((await rig.buy("ok")).outcome, "settled");
    // A positive wash flag still refuses: off skips the lookup, never an explicit finding.
    rig.world.defaultTrust = { decision: "block", score: 0, washFlagged: true };
    const second = await rig.buy("ok2");
    assert.equal(second.outcome, "refused");
    assert.equal(second.refusal.code, "trust_gate_refused");
  } finally {
    await rig.close();
  }
});

test("a trustScreen value that is not on or off fails mandate issue, not the runtime", async () => {
  const rig = await makeRig();
  try {
    const { issueMandate, keyFromSeed } = await import("../dist/index.js");
    const crypto = await import("node:crypto");
    assert.throws(
      () =>
        issueMandate({
          issuerMode: "self-mandated",
          issuerKey: keyFromSeed(crypto.randomBytes(32)),
          maxPerCallUsd: "0.05",
          dailyCeilingUsd: "1.00",
          allowedChains: ["solana"],
          minTrustScore: 75,
          trustScreen: "sometimes",
          allowedTools: [rig.tool],
          killswitchDir: rig.stateDir,
          lifetimeMs: 3_600_000,
        }),
      /trustScreen must be "on" or "off"/,
    );
  } finally {
    await rig.close();
  }
});

test("old mandates without trustScreen keep working: absent means on", async () => {
  const rig = await makeRig();
  try {
    assert.equal(rig.mandate.trustScreen, undefined);
    rig.world.trustDown = true;
    const result = await rig.buy("ok");
    assert.equal(result.outcome, "refused");
    assert.equal(result.refusal.code, "trust_gate_refused");
  } finally {
    await rig.close();
  }
});
