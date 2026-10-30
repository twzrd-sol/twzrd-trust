import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/tmpdir.js";
import {
  OUTCOME_LEDGER_SCHEMA,
  OutcomeLedgerBlockedError,
  OutcomeLedgerExpiredError,
  OutcomeLedgerTransitionError,
  createFileOutcomeLedger,
  createMemoryOutcomeLedger,
  type ApprovalBinding,
} from "../src/outcome-ledger.js";

const T0 = 1_760_000_000_000;
const approval = (over: Partial<ApprovalBinding> = {}): ApprovalBinding => ({
  payTo: "SELLER11111111111111111111111111111111111111",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amountAtomic: "1000",
  maxAllInAtomic: "1200",
  request: { method: "GET", url: "https://api.example/v1/data?q=1", bodyHash: "" },
  expiresAt: new Date(T0 + 60_000).toISOString(),
  validation: { schemaId: "dataset.v3", ruleVersion: "rules-2026-10-30" },
  ...over,
});
const H = (n: number) => "tiv1:" + n.toString(16).padStart(64, "0");

test("happy path: approved -> signing -> completed", () => {
  const l = createMemoryOutcomeLedger();
  const r0 = l.begin({ intentHash: H(1), decisionId: "d1", approval: approval(), now: T0 });
  assert.equal(r0.state, "approved");
  assert.equal(r0.schema, OUTCOME_LEDGER_SCHEMA);
  assert.equal(l.markSigning(H(1), T0 + 1).state, "signing");
  const done = l.complete(H(1), {
    settlement: { settlementTx: "5".repeat(88), amountAtomic: "1000", feesAtomic: "100" },
    validation: { ok: true, ruleVersion: "rules-2026-10-30" },
    now: T0 + 2,
  });
  assert.equal(done.state, "completed");
  assert.equal(done.settlement?.allInAtomic, "1100");
  assert.equal(done.settlement?.withinCap, true);
  assert.deepEqual(done.history.map((h) => h.state), ["approved", "signing", "completed"]);
  assert.deepEqual(l.unresolved(), []);
});

test("refused before signing is terminal and never reached the signer", () => {
  const l = createMemoryOutcomeLedger();
  l.begin({ intentHash: H(2), decisionId: "d2", approval: approval(), now: T0 });
  const r = l.refuse(H(2), { reasonCodes: ["payto_mismatch"], now: T0 + 1 });
  assert.equal(r.state, "refused");
  assert.deepEqual(r.reasonCodes, ["payto_mismatch"]);
  assert.throws(() => l.markSigning(H(2), T0 + 2), OutcomeLedgerTransitionError);
  // A refuse after signing is not a thing: the signer may have run.
  l.begin({ intentHash: H(3), decisionId: "d3", approval: approval(), now: T0 });
  l.markSigning(H(3), T0 + 1);
  assert.throws(() => l.refuse(H(3), { reasonCodes: ["late"] }), OutcomeLedgerTransitionError);
});

test("paid but incomplete: settlement confirmed, validation failed; fresh approval needed, same approval refused", () => {
  const l = createMemoryOutcomeLedger();
  l.begin({ intentHash: H(4), decisionId: "d4", approval: approval(), now: T0 });
  l.markSigning(H(4), T0 + 1);
  const r = l.complete(H(4), {
    settlement: { settlementTx: "6".repeat(88), amountAtomic: "1000" },
    validation: { ok: false, ruleVersion: "rules-2026-10-30", reasonCodes: ["schema_mismatch"] },
    now: T0 + 2,
  });
  assert.equal(r.state, "paid_incomplete");
  assert.deepEqual(r.reasonCodes, ["schema_mismatch"]);
  // Same approval again: refused. The approval is single-use.
  assert.deepEqual(l.canAttempt(H(4), "d4"), { ok: false, reason: "approval_reused_after_terminal", record: r });
  assert.throws(() => l.begin({ intentHash: H(4), decisionId: "d4", approval: approval() }), OutcomeLedgerBlockedError);
  // A decision id spent on another intent is also refused.
  assert.equal(l.canAttempt(H(5), "d4").ok, false);
  // Fresh approval on the same intent: allowed, because settlement IS established.
  assert.deepEqual(l.canAttempt(H(4), "d4b"), { ok: true });
  assert.equal(l.begin({ intentHash: H(4), decisionId: "d4b", approval: approval(), now: T0 + 3 }).state, "approved");
});

test("spend above the all-in cap or a different rule version is paid_incomplete, not completed", () => {
  const l = createMemoryOutcomeLedger();
  l.begin({ intentHash: H(6), decisionId: "d6", approval: approval(), now: T0 });
  l.markSigning(H(6), T0 + 1);
  const over = l.complete(H(6), {
    settlement: { settlementTx: "7".repeat(88), amountAtomic: "1000", feesAtomic: "201" },
    validation: { ok: true, ruleVersion: "rules-2026-10-30" },
    now: T0 + 2,
  });
  assert.equal(over.state, "paid_incomplete");
  assert.deepEqual(over.reasonCodes, ["spend_exceeds_approval"]);
  assert.equal(over.settlement?.withinCap, false);

  l.begin({ intentHash: H(7), decisionId: "d7", approval: approval(), now: T0 });
  l.markSigning(H(7), T0 + 1);
  const wrongRule = l.complete(H(7), {
    settlement: { settlementTx: "8".repeat(88), amountAtomic: "1000" },
    validation: { ok: true, ruleVersion: "rules-2026-01-01" },
    now: T0 + 2,
  });
  assert.equal(wrongRule.state, "paid_incomplete");
  assert.deepEqual(wrongRule.reasonCodes, ["validation_rule_mismatch"]);
});

test("payment outcome unknown blocks every new attempt on that intent until reconciled", () => {
  const l = createMemoryOutcomeLedger();
  l.begin({ intentHash: H(8), decisionId: "d8", approval: approval(), now: T0 });
  l.markSigning(H(8), T0 + 1);
  const u = l.markUnknown(H(8), { cause: "AbortError: timeout after send", now: T0 + 2 });
  assert.equal(u.state, "unknown");
  assert.equal(u.unknownCause, "AbortError: timeout after send");
  assert.equal(l.unresolved().length, 1);
  // Fresh approval does NOT bypass an unresolved payment.
  const blocked = l.canAttempt(H(8), "d8-fresh");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, "unresolved_attempt");
  assert.throws(() => l.begin({ intentHash: H(8), decisionId: "d8-fresh", approval: approval() }), OutcomeLedgerBlockedError);
  // complete() without a settlement tx is still unknown; refuse to call that completed.
  assert.throws(
    () => l.complete(H(8), { settlement: { settlementTx: "", amountAtomic: "1000" }, validation: { ok: true, ruleVersion: "rules-2026-10-30" } }),
    TypeError,
  );
  // Reconciled: no settlement found. Terminal, and a fresh approval may proceed.
  const ns = l.markNotSettled(H(8), { reasonCodes: ["no_tx_for_intent_in_window"], now: T0 + 3 });
  assert.equal(ns.state, "not_settled");
  assert.deepEqual(l.unresolved(), []);
  assert.deepEqual(l.canAttempt(H(8), "d8-fresh"), { ok: true });
});

test("reconciled unknown can also land as completed when settlement is found later", () => {
  const l = createMemoryOutcomeLedger();
  l.begin({ intentHash: H(9), decisionId: "d9", approval: approval(), now: T0 });
  l.markSigning(H(9), T0 + 1);
  l.markUnknown(H(9), { cause: "ECONNRESET", now: T0 + 2 });
  const r = l.complete(H(9), {
    settlement: { settlementTx: "9".repeat(88), amountAtomic: "1000" },
    validation: { ok: true, ruleVersion: "rules-2026-10-30" },
    now: T0 + 60_000,
  });
  assert.equal(r.state, "completed");
});

test("expired approval at markSigning records `expired` and never signs", () => {
  const l = createMemoryOutcomeLedger();
  l.begin({ intentHash: H(10), decisionId: "d10", approval: approval(), now: T0 });
  assert.throws(() => l.markSigning(H(10), T0 + 60_000), OutcomeLedgerExpiredError);
  assert.equal(l.get(H(10))?.state, "expired");
  assert.deepEqual(l.get(H(10))?.reasonCodes, ["approval_expired"]);
  // Unparseable expiry fails closed too.
  l.begin({ intentHash: H(11), decisionId: "d11", approval: approval({ expiresAt: new Date(T0 + 1).toISOString() }), now: T0 });
  assert.throws(() => l.markSigning(H(11), T0 + 1), OutcomeLedgerExpiredError);
});

test("an in-flight approval on the same intent blocks a duplicate begin", () => {
  const l = createMemoryOutcomeLedger();
  l.begin({ intentHash: H(12), decisionId: "d12", approval: approval(), now: T0 });
  assert.throws(() => l.begin({ intentHash: H(12), decisionId: "d12-dup", approval: approval() }), OutcomeLedgerBlockedError);
});

test("approval binding is validated: money is a base-unit string, rule version is required", () => {
  const l = createMemoryOutcomeLedger();
  assert.throws(() => l.begin({ intentHash: H(13), decisionId: "x", approval: approval({ amountAtomic: "0.001" }) }), TypeError);
  assert.throws(() => l.begin({ intentHash: H(13), decisionId: "x", approval: approval({ amountAtomic: "1e3" }) }), TypeError);
  assert.throws(() => l.begin({ intentHash: H(13), decisionId: "x", approval: approval({ validation: { ruleVersion: "" } }) }), TypeError);
  assert.throws(() => l.begin({ intentHash: H(13), decisionId: "x", approval: approval({ expiresAt: "soon" }) }), TypeError);
  // None of those failures consumed the decision id.
  assert.deepEqual(l.canAttempt(H(13), "x"), { ok: true });
});

test("file ledger: the signing row is on disk before markSigning returns, and survives a restart as unresolved", () => {
  const path = join(tempDir("twzrd-outcome-ledger-"), "outcomes.jsonl");
  const l = createFileOutcomeLedger(path);
  l.begin({ intentHash: H(20), decisionId: "d20", approval: approval(), now: T0 });
  l.markSigning(H(20), T0 + 1);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const last = JSON.parse(lines[1]!);
  assert.equal(last.state, "signing");
  assert.equal(last.schema, OUTCOME_LEDGER_SCHEMA);
  // "Process died while the signer ran": a new instance replays the file.
  const l2 = createFileOutcomeLedger(path);
  assert.equal(l2.get(H(20))?.state, "signing");
  assert.equal(l2.unresolved().length, 1);
  assert.equal(l2.canAttempt(H(20), "d20-fresh").ok, false);
  // Reconcile on the new instance, then the chain continues.
  l2.markNotSettled(H(20), { now: T0 + 5 });
  const l3 = createFileOutcomeLedger(path);
  assert.equal(l3.get(H(20))?.state, "not_settled");
  assert.deepEqual(l3.get(H(20))?.history.map((h) => h.state), ["approved", "signing", "not_settled"]);
});

test("file ledger fails closed on a broken chain or a corrupt row", () => {
  const dir = tempDir("twzrd-outcome-ledger-bad-");
  const path = join(dir, "outcomes.jsonl");
  const l = createFileOutcomeLedger(path);
  l.begin({ intentHash: H(21), decisionId: "d21", approval: approval(), now: T0 });
  l.markSigning(H(21), T0 + 1);
  l.markUnknown(H(21), { cause: "timeout", now: T0 + 2 });
  // Drop the unknown row: an edit that would make the attempt look less resolved-pending than it is.
  const lines = readFileSync(path, "utf8").trim().split("\n");
  writeFileSync(path, lines.slice(0, 2).join("\n") + "\n");
  // Truncation to a prefix keeps the chain valid, so the record reads as `signing`: still unresolved.
  assert.equal(createFileOutcomeLedger(path).get(H(21))?.state, "signing");
  // Editing a middle row in place breaks the next row's prev hash.
  writeFileSync(path, [lines[0], lines[1]!.replace(/"at":\d+/, `"at":${T0 + 99}`), lines[2]].join("\n") + "\n");
  assert.throws(() => createFileOutcomeLedger(path), /chain broken/);
  const path2 = join(dir, "corrupt.jsonl");
  writeFileSync(path2, "{not json\n");
  assert.throws(() => createFileOutcomeLedger(path2), /corrupt row/);
});
