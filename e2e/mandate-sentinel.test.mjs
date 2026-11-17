// twzrd-sentinel, end to end: the daemon as a child process on loopback,
// its records rechecked from outside, then the vectors that must stop it.
// See mandate-lib.mjs.
//
//   1 discover        paid tasks are read from the catalog, through the mandate
//   2 screen          each seller is checked before anything is signed
//   3 hold            a budget hold is taken; what does not fit is refused
//   4 pay             one payment leaves for each task the mandate allows
//   5 receipt         V7 under the pinned key, and inclusion in the receipt log
//   6 reconcile       quoted against settled, in three hash-chained ledgers
//   7 attest          the agent signs a heartbeat over the ledger head
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { heartbeatHash, verifyHeartbeat, verifyMandate } from "../twzrd-mandate/dist/index.js";
import { SENTINEL_CLI, freePort, micro, reconcile, runCli, startSentinel, tempDir, verifyReceiptTwice, writeFixtureDir } from "./mandate-lib.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const USD = /^\d+(\.\d+)?$/;
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** A mandate and key on disk for a sentinel whose loopback seller will listen on `port`. */
const ownMandate = (port, overrides = {}) => writeFixtureDir({ base: `http://127.0.0.1:${port}` }, overrides, { payer: false });

/** What the recorded-session contract (twzrd.mandate.session.v1) requires. Returns what is wrong. */
function sessionProblems(session) {
  const problems = [];
  const need = (ok, what) => ok || problems.push(what);
  need(session.schema === "twzrd.mandate.session.v1", "schema");
  need(session.environment === "loopback", "environment");
  need(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(session.recordedAt), "recordedAt is not UTC");
  need(session.source?.package === "@twzrd1111/mandate" && /^\d+\.\d+\.\d+$/.test(session.source?.version) && /^[0-9a-f]{40}$/.test(session.source?.commit), "source");
  need(!("provisional" in session), "a real recording is not provisional");
  need(Array.isArray(session.steps) && session.steps.length > 0, "steps");
  (session.steps ?? []).forEach((step, i) => {
    const at = `step ${i + 1}`;
    need(step.n === i + 1, `${at}: n`);
    need(typeof step.title === "string" && step.title && typeof step.tool === "string" && typeof step.kind === "string", `${at}: title, tool, kind`);
    need(["settled", "refused", "free"].includes(step.outcome), `${at}: outcome`);
    need(typeof step.detail === "string" && step.detail.length > 0, `${at}: detail`);
    need(HEX64.test(step.ledgerHead), `${at}: ledgerHead`);
    need(USD.test(step.remainingHourUsd) && USD.test(step.remainingDayUsd), `${at}: remaining budget`);
    need(["verified", "absent", "invalid"].includes(step.receipt?.status), `${at}: receipt status`);
    need(["proven", "pending", "failed", "not_checked"].includes(step.inclusion?.status), `${at}: inclusion status`);
    if (step.outcome === "refused") {
      need(Number.isInteger(step.layer) && step.layer >= 1 && step.layer <= 6, `${at}: a refusal names its layer`);
      need(typeof step.code === "string" && step.code, `${at}: a refusal names its code`);
      need(step.signatures === 0 && step.settledUsd === null, `${at}: a refusal signs nothing and settles nothing`);
    } else {
      need(step.layer === null, `${at}: only a refusal has a layer`);
    }
    if (step.outcome === "free") need(step.signatures === 0, `${at}: a free call signs nothing`);
    if (step.outcome === "settled") {
      need(USD.test(step.settledUsd ?? "") && USD.test(step.quotedUsd ?? ""), `${at}: settled and quoted amounts`);
      need(step.signatures === 1, `${at}: one signature for one payment`);
    }
    if (step.receipt?.status !== "absent") {
      need(step.receipt.document && typeof step.receipt.document === "object", `${at}: a receipt that is not absent is in the file`);
      need(HEX64.test(String(step.receipt.leaf ?? "").replace(/^0x/, "")), `${at}: receipt leaf`);
    }
  });
  return problems;
}

// ---- stages ----------------------------------------------------------------

test("stages 1-7: two daemon cycles as a child process, and every record rechecked from outside", () => {
  const dir = tempDir();
  const out = runCli(SENTINEL_CLI, ["run", "--dir", dir, "--cycles", "2", "--interval", "0", "--loopback-port", "0", "--json"], dir);
  assert.equal(out.code, 0, out.stderr);
  const events = out.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const steps = events.filter((e) => e.event === "step");
  const beats = events.filter((e) => e.event === "heartbeat").map((e) => e.heartbeat);
  const mandate = readJson(path.join(dir, "mandate.json"));
  const stateDir = path.join(dir, ".twzrd-mandate");

  // 1: discovery is itself a call under the mandate. 2-4: the honest tasks are paid once each;
  // the wash seller (screen), the over-cap price (hold) and the unreadable 402 are refused unsigned.
  assert.deepEqual(
    steps.slice(0, 6).map((s) => [s.kind, s.outcome, s.layer, s.code, s.signatures]),
    [
      ["discover", "free", null, null, 0],
      ["paid-task", "settled", null, null, 1],
      ["paid-task", "refused", 5, "trust_gate_refused", 0],
      ["paid-task", "refused", 4, "per_request_cap", 0],
      ["paid-task", "refused", 6, "payment_required_unreadable", 0],
      ["paid-task", "settled", null, null, 1],
    ],
  );
  assert.equal(steps.length, 12);
  // 5: each settled step's receipt verified and its inclusion was proven.
  for (const step of steps.filter((s) => s.outcome === "settled")) {
    assert.deepEqual([step.receipt.status, step.receipt.version, step.inclusion.status, step.quotedUsd === step.settledUsd], ["verified", "v7", "proven", true]);
  }

  // 6: the three ledgers on disk chain and agree: 2 x (0.01 + 0.02) settled, four signatures, no signed refusal.
  const books = reconcile(stateDir, null, mandate.mandateId);
  assert.deepEqual(books.mismatches, []);
  assert.deepEqual([books.decisionMicro, books.toolMicro, books.gateMicro, books.signatures, books.rows.length], [60_000, 60_000, 60_000, 4, 12]);

  // 7: both heartbeats are signed by the mandate's agent, chain to each other, and the last one
  // states the ledger head recomputed here.
  assert.equal(beats.length, 2);
  for (const beat of beats) assert.equal(verifyHeartbeat(beat, { agent: mandate.agent }).ok, true);
  assert.deepEqual([beats[0].prevHeartbeatHash, beats[1].prevHeartbeatHash], ["genesis", heartbeatHash(beats[0])]);
  assert.deepEqual([beats[1].decisions, beats[1].refusals, beats[1].settledUsd, beats[1].remainingBudgetUsd.day, beats[1].ledgerHeadHash], [12, 6, "0.06", "1.94", books.head]);
  assert.deepEqual(readJson(path.join(stateDir, "heartbeat.json")), beats[1]);
  // A heartbeat with one figure changed no longer verifies.
  assert.equal(verifyHeartbeat({ ...beats[1], refusals: 0 }, { agent: mandate.agent }).ok, false);

  // The daemon's files are private to its user, and its output never carries the key.
  for (const file of ["agent.json", path.join(".twzrd-mandate", "mandate-ledger.jsonl"), path.join(".twzrd-mandate", "heartbeat.json")]) {
    assert.equal(fs.statSync(path.join(dir, file)).mode & 0o077, 0, file);
  }
  const key = Buffer.from(readJson(path.join(dir, "agent.json")));
  assert.equal(key.length, 64);
  const printed = out.stdout + out.stderr;
  for (const form of [JSON.stringify([...key]), [...key].join(","), key.subarray(0, 32).toString("hex"), key.subarray(0, 32).toString("base64"), key.toString("base64")]) {
    assert.equal(printed.includes(form), false, "the agent key was printed");
  }
});

test("a recorded session meets the session contract, and its receipts verify with both verifiers", () => {
  const dir = tempDir();
  const file = path.join(dir, "session.json");
  const commit = crypto.randomBytes(20).toString("hex");
  const out = runCli(SENTINEL_CLI, ["run", "--dir", dir, "--loopback-port", "0", "--record", file, "--source-commit", commit], dir);
  assert.equal(out.code, 0, out.stderr);
  const session = readJson(file);
  assert.deepEqual(sessionProblems(session), []);
  assert.equal(session.source.commit, commit);

  // Every layer from 2 to 6 refused, unsigned; layer 1 is the mandate itself, proven by --verify-breakers.
  const refused = session.steps.filter((s) => s.outcome === "refused");
  assert.deepEqual(refused.map((s) => [s.layer, s.code]), [
    [5, "trust_gate_refused"],
    [4, "per_request_cap"],
    [6, "payment_required_unreadable"],
    [3, "tool_not_allowed"],
    [2, "kill_switch"],
  ]);
  const settled = session.steps.filter((s) => s.outcome === "settled");
  for (const step of settled) {
    const checked = verifyReceiptTwice(step.receipt.document);
    assert.deepEqual([checked.ok, step.receipt.status, step.inclusion.status], [true, "verified", "proven"]);
    assert.ok(step.inclusion.leafIndex < step.inclusion.treeSize);
  }
  // The totals are the steps added up, the heartbeat agrees, and the mandate in the file still verifies.
  const sum = (rows, field) => rows.reduce((total, row) => total + micro(row[field]), 0);
  assert.deepEqual(session.totals, {
    decisions: session.steps.length,
    settled: settled.length,
    refusals: refused.length,
    settledUsd: (sum(settled, "settledUsd") / 1e6).toString(),
    signatures: session.steps.reduce((total, step) => total + step.signatures, 0),
  });
  assert.deepEqual([session.totals.settled, session.totals.refusals, session.totals.signatures], [2, 5, 2]);
  assert.equal(verifyMandate(session.mandate, { heldAgentKey: session.mandate.agent }).ok, true);
  assert.equal(verifyHeartbeat(session.heartbeat, { agent: session.mandate.agent }).ok, true);
  assert.deepEqual(
    [session.heartbeat.mandateId, session.heartbeat.decisions, session.heartbeat.refusals, session.heartbeat.settledUsd, session.heartbeat.ledgerHeadHash],
    [session.mandate.mandateId, session.totals.decisions, session.totals.refusals, session.totals.settledUsd, session.steps.at(-1).ledgerHead],
  );
  // The file names no path on the machine that made it.
  assert.equal(fs.readFileSync(file, "utf8").includes(dir), false);
  // An edited receipt in the file is caught by both verifiers.
  const forged = structuredClone(settled[0].receipt.document);
  assert.equal(typeof forged.preimage.score, "number");
  forged.preimage.score = forged.preimage.score === 100 ? 99 : 100;
  assert.equal(verifyReceiptTwice(forged).ok, false);
});

test("--verify-breakers: all six pre-sign layers refuse with no signature, whatever the host environment says", () => {
  const hostile = {
    KILLSWITCH_MAX_USD_DAY: "100000",
    KILLSWITCH_MAX_COST_REQUEST: "100000",
    KILLSWITCH_KILL_FILE: "/nonexistent/.kill",
    TWZRD_ENFORCEMENT_MODE: "observe",
    TWZRD_MANDATE_TRUSTED_ISSUERS: "11111111111111111111111111111111",
    HTTPS_PROXY: "http://127.0.0.1:9",
  };
  const out = runCli(SENTINEL_CLI, ["--verify-breakers", "--json"], tempDir(), hostile);
  assert.equal(out.code, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.deepEqual([report.ok, report.layersProven, report.totalSignatures, report.totalSellerPayments, report.strayRequests], [true, [1, 2, 3, 4, 5, 6], 0, 0, 0]);
  assert.ok(report.cases.length >= 6);
  for (const c of report.cases) {
    assert.deepEqual([c.passed, c.actualCode, c.actualLayer, c.signatures, c.sellerPayments], [true, c.expectedCode, c.layer, 0, 0], c.name);
  }
  for (const layer of [1, 2, 3, 4, 5, 6]) assert.ok(report.cases.some((c) => c.layer === layer), `no case for layer ${layer}`);
});

// ---- adversarial vectors ---------------------------------------------------

test("vector: an expired mandate. The daemon will not start on one, and exits 3 when one runs out under it", async () => {
  const port = await freePort();
  const stale = ownMandate(port, { lifetimeMs: 60_000, now: Date.now() - 3_600_000 });
  const refused = runCli(SENTINEL_CLI, ["run", "--dir", stale.dir, "--cycles", "1", "--loopback-port", String(port)], stale.dir);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /mandate_expired/);
  assert.equal(fs.existsSync(path.join(stale.stateDir, "mandate-ledger.jsonl")), false);

  const brief = ownMandate(await freePort(), { lifetimeMs: 4000 });
  const daemon = startSentinel(brief.dir, ["--interval", "1", "--loopback-port", brief.tool.split(":").at(-1)]);
  assert.equal(await daemon.exited, 3, daemon.stderr());
  assert.match(daemon.stderr(), /mandate_expired/);
  const beats = daemon.heartbeats();
  assert.ok(beats.length >= 2, `only ${beats.length} heartbeat(s)`);
  // Nothing was signed after the mandate ran out: the ledger has no call dated past its expiry.
  const books = reconcile(brief.stateDir, null, brief.mandate.mandateId);
  assert.deepEqual(books.mismatches, []);
  const expiry = Date.parse(brief.mandate.expiresAt);
  const late = books.rows.filter((row) => Date.parse(row.at) > expiry + 1000 && row.signatures > 0);
  assert.deepEqual(late, []);
  assert.equal(beats.at(-1).heartbeat.ledgerHeadHash, books.head);
});

test("vector: a tampered mandate. The daemon exits 2 before it opens anything", async () => {
  const port = await freePort();
  const fixture = ownMandate(port);
  const file = path.join(fixture.dir, "mandate.json");
  const good = readJson(file);
  const { signature: _dropped, ...unsigned } = good;
  for (const [name, doc, expected] of [
    ["the daily ceiling raised", { ...good, limits: { ...good.limits, dailyCeilingUsd: "1000.00" } }, /mandate_signature_invalid/],
    ["inclusion no longer required", { ...good, requireMerkleInclusion: false }, /mandate_signature_invalid/],
    ["the trust floor lowered", { ...good, minTrustScore: 0 }, /mandate_signature_invalid/],
    ["the signature removed", unsigned, /mandate_unsigned/],
    ["an unknown member added", { ...good, unlimited: true }, /mandate_malformed/],
  ]) {
    fs.writeFileSync(file, JSON.stringify(doc));
    const out = runCli(SENTINEL_CLI, ["run", "--dir", fixture.dir, "--cycles", "1", "--loopback-port", String(port)], fixture.dir);
    assert.equal(out.code, 2, name);
    assert.match(out.stderr, expected, name);
  }
  assert.equal(fs.existsSync(fixture.stateDir), false, "a refused start left a state directory behind");
  fs.writeFileSync(file, JSON.stringify(good));
  const ok = runCli(SENTINEL_CLI, ["run", "--dir", fixture.dir, "--cycles", "1", "--interval", "0", "--loopback-port", String(port)], fixture.dir);
  assert.equal(ok.code, 0, ok.stderr);
});

test("vector: .kill under a running daemon. It idles unsigned and keeps attesting; a second daemon cannot share its state", async () => {
  const dir = tempDir();
  const daemon = startSentinel(dir, ["--interval", "1", "--loopback-port", "0"]);
  try {
    assert.ok(await daemon.until(() => daemon.heartbeats().length >= 1), daemon.stderr());

    // A second daemon on the same state directory is refused while the first holds it.
    const second = runCli(SENTINEL_CLI, ["run", "--dir", dir, "--cycles", "1", "--loopback-port", "0"], dir);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /in use by process/);

    fs.writeFileSync(path.join(dir, ".twzrd-mandate", ".kill"), "e2e\n");
    const seen = daemon.heartbeats().length;
    // The cycle in progress may finish; the two after it are idle.
    assert.ok(await daemon.until(() => daemon.heartbeats().length >= seen + 3), daemon.stderr());
    const beats = daemon.heartbeats();
    const [before, last] = [beats.at(-2), beats.at(-1)];
    assert.deepEqual([last.heartbeat.settledUsd, last.ok], [before.heartbeat.settledUsd, true]);
    const afterBefore = daemon.events.slice(daemon.events.indexOf(before) + 1);
    assert.deepEqual(afterBefore.filter((e) => e.event === "step"), [], "a killed daemon still took a step");
    assert.equal(last.heartbeat.seq, before.heartbeat.seq + 1);
  } finally {
    assert.equal(await daemon.stop(), 0, daemon.stderr());
  }
  // What it signed before the kill is all it ever signed, and the books still close.
  const mandate = readJson(path.join(dir, "mandate.json"));
  const books = reconcile(path.join(dir, ".twzrd-mandate"), null, mandate.mandateId);
  assert.deepEqual(books.mismatches, []);
  assert.equal(books.decisionMicro, books.signatures * 15_000);
});

test("vector: a ledger edited under a running daemon. The next cycle does not verify and the daemon exits 1", async () => {
  const dir = tempDir();
  const daemon = startSentinel(dir, ["--interval", "1", "--loopback-port", "0"]);
  assert.ok(await daemon.until(() => daemon.heartbeats().length >= 1), daemon.stderr());
  const file = path.join(dir, ".twzrd-mandate", "mandate-ledger.jsonl");
  // Rewrite the first settled line as if it had cost nothing.
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes('"settledUsd":"0.01"'));
  fs.writeFileSync(file, text.replace('"settledUsd":"0.01"', '"settledUsd":"0.00"'));
  const code = await Promise.race([daemon.exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 15_000))]);
  if (code === "still running") await daemon.stop();
  assert.equal(code, 1, daemon.stderr());
  assert.equal(reconcile(path.join(dir, ".twzrd-mandate"), null, readJson(path.join(dir, "mandate.json")).mandateId).ok, false);
});
