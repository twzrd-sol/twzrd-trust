// twzrd-sentinel on loopback: the loop, the recorder, the breaker proof, and
// what the daemon does when its mandate is stopped, expired or not its own.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_STH_PUBKEY,
  RECEIPT_ISSUER_PUBKEY,
  checkReceipt,
  issueMandate,
  keyFromSeed,
  loadKeyFile,
  verifyDecisionLedger,
  verifyHeartbeat,
  verifyMandate,
  writeMandateFile,
} from "@twzrd1111/mandate";
import { openSentinel, recordSession, runCycle, runLoop, tasksFromCatalog } from "../lib/sentinel.mjs";

const CLI = fileURLToPath(new URL("../sentinel.mjs", import.meta.url));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "twzrd-sentinel-test-"));
const env = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TWZRD_|KILLSWITCH_)/.test(key)));
for (const key of Object.keys(process.env)) if (/^(TWZRD_|KILLSWITCH_)/.test(key)) delete process.env[key];

const run = (args, cwd) => {
  const out = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(), encoding: "utf8", timeout: 60_000 });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
};

test("a loopback cycle: discover, settle the honest tasks, refuse the rest unsigned, sign a heartbeat", async () => {
  const dir = tempDir();
  const sentinel = await openSentinel({ dir, loopbackPort: 0 });
  try {
    assert.equal(sentinel.mode, "loopback");
    assert.deepEqual([sentinel.mandate.issuerMode, sentinel.mandate.issuer === sentinel.mandate.agent], ["self-mandated", true]);
    const first = await runCycle(sentinel);
    assert.equal(first.ok, true);
    assert.equal(first.discovered, 5);
    assert.deepEqual(
      first.steps.map((s) => [s.kind, s.outcome, s.layer, s.code, s.signatures]),
      [
        ["discover", "free", null, null, 0],
        ["paid-task", "settled", null, null, 1],
        ["paid-task", "refused", 5, "trust_gate_refused", 0],
        ["paid-task", "refused", 4, "per_request_cap", 0],
        ["paid-task", "refused", 6, "payment_required_unreadable", 0],
        ["paid-task", "settled", null, null, 1],
      ],
    );
    // What was paid is what the seller received, and nothing else was signed.
    assert.deepEqual([sentinel.world.payer.signatures, sentinel.world.paidCount, sentinel.world.receivedMicro, sentinel.world.strays.length], [2, 2, 30_000, 0]);
    // Each settled step carries a receipt that verifies under the pinned key, and its inclusion proof.
    for (const step of first.steps.filter((s) => s.outcome === "settled")) {
      assert.deepEqual([step.receipt.status, step.receipt.version, step.inclusion.status], ["verified", "v7", "proven"]);
      const again = checkReceipt(step.receipt.document, { subjects: [step.receipt.document.preimage?.agent_id ?? step.receipt.document.agent_id].filter(Boolean), requireV7: true });
      assert.equal(again.leaf, step.receipt.leaf);
    }
    assert.ok(RECEIPT_ISSUER_PUBKEY.length > 30 && DEFAULT_STH_PUBKEY.length > 30);

    // The heartbeat is signed by the agent and states the ledger as it stands.
    const beat = first.heartbeat;
    assert.equal(verifyHeartbeat(beat, { agent: sentinel.mandate.agent }).ok, true);
    assert.deepEqual([beat.seq, beat.decisions, beat.refusals, beat.settledUsd, beat.remainingBudgetUsd, beat.prevHeartbeatHash], [1, 6, 3, "0.03", { hour: "0.47", day: "1.97" }, "genesis"]);
    assert.equal(beat.ledgerHeadHash, sentinel.runtime.ledger.head());
    assert.equal(verifyHeartbeat({ ...beat, settledUsd: "0.00" }, { agent: sentinel.mandate.agent }).ok, false);

    // A second cycle continues the same ledger and chains its heartbeat to the first.
    const second = await runCycle(sentinel);
    assert.deepEqual([second.ok, second.heartbeat.seq, second.heartbeat.decisions, second.heartbeat.settledUsd], [true, 2, 12, "0.06"]);
    assert.match(second.heartbeat.prevHeartbeatHash, /^[0-9a-f]{64}$/);
    const ledger = verifyDecisionLedger(path.join(sentinel.runtime.stateDir, "mandate-ledger.jsonl"));
    assert.deepEqual([ledger.ok, ledger.lines, ledger.head], [true, 12, second.heartbeat.ledgerHeadHash]);
  } finally {
    await sentinel.close();
  }
});

test("the kill file idles the loop: nothing is discovered, asked or signed, and the heartbeat says so", async () => {
  const dir = tempDir();
  const sentinel = await openSentinel({ dir, loopbackPort: 0 });
  try {
    await runCycle(sentinel);
    const hitsBefore = sentinel.world.hits.length;
    fs.writeFileSync(path.join(sentinel.runtime.stateDir, ".kill"), "stop\n");
    const cycles = [];
    const result = await runLoop(sentinel, { cycles: 2, intervalMs: 0, onCycle: (c) => cycles.push(c) });
    assert.deepEqual([result.exitCode, result.reason], [0, "cycles_done"]);
    assert.deepEqual(cycles.map((c) => [c.stopped.code, c.steps.length, c.ok]), [["kill_switch", 0, true], ["kill_switch", 0, true]]);
    assert.equal(sentinel.world.hits.length, hitsBefore, "a halted sentinel still made requests");
    assert.equal(sentinel.world.payer.signatures, 2);
    // An operator resumes; the next cycle works again.
    sentinel.runtime.resume();
    const after = await runCycle(sentinel);
    assert.deepEqual([after.stopped, after.steps.filter((s) => s.outcome === "settled").length], [null, 2]);
  } finally {
    await sentinel.close();
  }
});

test("the daily ceiling ends the spending, not the daemon", async () => {
  const dir = tempDir();
  // Open once to learn the loopback tool name, then reissue a tighter mandate for the same world port.
  const probe = await openSentinel({ dir, loopbackPort: 0 });
  const port = new URL(probe.world.base).port;
  await probe.close();
  fs.rmSync(path.join(dir, "mandate.json"));
  fs.rmSync(path.join(dir, ".twzrd-mandate"), { recursive: true, force: true });
  const held = loadKeyFile(path.join(dir, "agent.json"));
  writeMandateFile(
    path.join(dir, "mandate.json"),
    issueMandate({ issuerMode: "self-mandated", issuerKey: held, maxPerCallUsd: "0.05", dailyCeilingUsd: "0.05", allowedChains: ["solana"], minTrustScore: 75, allowedTools: [`http:127.0.0.1:${port}`], requireV7Receipt: true, requireMerkleInclusion: true, killswitchDir: ".twzrd-mandate", lifetimeMs: 3_600_000 }),
  );
  const sentinel = await openSentinel({ dir, loopbackPort: Number(port) });
  try {
    const first = await runCycle(sentinel);
    assert.equal(first.heartbeat.settledUsd, "0.03");
    const second = await runCycle(sentinel);
    // 0.02 is left after the first cycle, so later cycles run into the ceiling.
    const third = await runCycle(sentinel);
    const codes = [...second.steps, ...third.steps].filter((s) => s.title.includes("lookup") || s.title.includes("report")).map((s) => s.code ?? s.outcome);
    assert.ok(codes.includes("budget_exceeded"), codes.join(","));
    const micro = (usd) => Math.round(Number(usd) * 1e6);
    assert.ok(micro(third.heartbeat.settledUsd) <= 50_000, third.heartbeat.settledUsd);
    assert.equal(micro(third.heartbeat.remainingBudgetUsd.day), 50_000 - micro(third.heartbeat.settledUsd));
    // The seller received exactly what the ledger says was settled.
    assert.equal(sentinel.world.receivedMicro, micro(third.heartbeat.settledUsd));
    assert.equal(third.ok, true);
  } finally {
    await sentinel.close();
  }
});

test("it will not start under a mandate that is not its own, is edited, or has expired", async () => {
  const dir = tempDir();
  const first = await openSentinel({ dir, loopbackPort: 0 });
  await first.close();
  const mandatePath = path.join(dir, "mandate.json");
  const good = fs.readFileSync(mandatePath, "utf8");

  // Edited: the daily ceiling raised after signing.
  const edited = JSON.parse(good);
  edited.limits.dailyCeilingUsd = "2000.00";
  fs.writeFileSync(mandatePath, JSON.stringify(edited));
  await assert.rejects(openSentinel({ dir, loopbackPort: 0 }), /mandate_signature_invalid/);

  // Another agent's key in place of this one.
  fs.writeFileSync(mandatePath, good);
  const otherDir = tempDir();
  const other = await openSentinel({ dir: otherDir, loopbackPort: 0 });
  await other.close();
  await assert.rejects(openSentinel({ dir, agentKey: path.join(otherDir, "agent.json"), loopbackPort: 0 }), /refusing to start/);

  // An operator-signed mandate needs that operator pinned.
  const operator = keyFromSeed(crypto.randomBytes(32));
  const agent = loadKeyFile(path.join(dir, "agent.json"));
  const signed = issueMandate({ issuerMode: "human-operator", issuerKey: operator, agent: agent.publicKey, maxPerCallUsd: "0.05", dailyCeilingUsd: "1.00", allowedChains: ["solana"], minTrustScore: 75, allowedTools: ["http:127.0.0.1:1"], killswitchDir: ".twzrd-mandate", lifetimeMs: 3_600_000 });
  fs.writeFileSync(mandatePath, JSON.stringify(signed));
  await assert.rejects(openSentinel({ dir, loopbackPort: 0 }), /mandate_issuer_untrusted/);
  const pinned = await openSentinel({ dir, loopbackPort: 0, trustIssuers: [operator.publicKey] });
  try {
    assert.equal(pinned.mandate.issuerMode, "human-operator");
    // This mandate does not name the loopback seller, so the catalog read itself is refused: layer 3, nothing sent.
    const cycle = await runCycle(pinned);
    assert.deepEqual(cycle.steps.map((s) => [s.outcome, s.layer, s.code]), [["refused", 3, "tool_not_allowed"]]);
    assert.equal(pinned.world.hits.length, 0);
  } finally {
    await pinned.close();
  }

  // Expired: issued in the past with a lifetime that has run out.
  const expired = issueMandate({ issuerMode: "self-mandated", issuerKey: agent, maxPerCallUsd: "0.05", dailyCeilingUsd: "1.00", allowedChains: ["solana"], minTrustScore: 75, allowedTools: ["http:127.0.0.1:1"], killswitchDir: ".twzrd-mandate", lifetimeMs: 60_000, now: Date.now() - 3_600_000 });
  assert.equal(verifyMandate(expired, { heldAgentKey: agent.publicKey }).code, "mandate_expired");
  fs.writeFileSync(mandatePath, JSON.stringify(expired));
  await assert.rejects(openSentinel({ dir, loopbackPort: 0 }), /mandate_expired/);

  // Live mode never issues its own mandate, and loopback never takes a pay module.
  await assert.rejects(openSentinel({ dir: tempDir(), live: true }), /needs --mandate/);
  await assert.rejects(openSentinel({ dir: tempDir(), payModule: "pay.mjs", loopbackPort: 0 }), /live mode/);
});

test("a recorded session: every layer from 2 to 6 refuses unsigned, and the file adds up", async () => {
  const dir = tempDir();
  const sentinel = await openSentinel({ dir, loopbackPort: 0 });
  try {
    await assert.rejects(recordSession(sentinel, { commit: "HEAD" }), /40-character commit/);
    const session = await recordSession(sentinel, { commit: "a".repeat(40) });
    assert.deepEqual([session.schema, session.environment, session.source.package, session.provisional], ["twzrd.mandate.session.v1", "loopback", "@twzrd1111/mandate", undefined]);
    assert.deepEqual(session.steps.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8]);
    const refused = session.steps.filter((s) => s.outcome === "refused");
    assert.deepEqual(refused.map((s) => s.layer).sort(), [2, 3, 4, 5, 6]);
    assert.deepEqual(refused.map((s) => [s.signatures, s.settledUsd]), Array(5).fill([0, null]));
    assert.deepEqual(session.totals, { decisions: 8, settled: 2, refusals: 5, settledUsd: "0.03", signatures: 2 });
    assert.deepEqual([session.payerSignatures, session.sellerPayments, session.strayRequests], [2, 2, 0]);
    // The heartbeat is the last word on the ledger, and the mandate in the file still verifies.
    assert.equal(session.heartbeat.ledgerHeadHash, session.steps.at(-1).ledgerHead);
    assert.deepEqual([session.heartbeat.decisions, session.heartbeat.refusals, session.heartbeat.settledUsd], [8, 5, "0.03"]);
    assert.equal(verifyHeartbeat(session.heartbeat, { agent: session.mandate.agent }).ok, true);
    assert.equal(verifyMandate(session.mandate, { heldAgentKey: session.mandate.agent }).ok, true);
    // Nothing in the file names this machine.
    const text = JSON.stringify(session);
    assert.equal(text.includes(dir), false);
    assert.equal(text.includes(os.homedir()), false);
  } finally {
    await sentinel.close();
  }
});

test("reading a catalog: only plain GET offers with an http(s) URL become tasks", () => {
  const doc = {
    offers: [
      { id: "a", title: "A", resource: "https://seller.example/v1/a", method: "GET" },
      { id: "b", resource: "https://seller.example:8443/v1/b" },
      { id: "c", resource: "https://seller.example/v1/c", method: "POST" },
      { id: "d", resource: "ftp://seller.example/d" },
      { id: "e", resource: "not a url" },
      { id: 7, resource: "https://seller.example/7" },
      null,
      "x",
    ],
  };
  assert.deepEqual(tasksFromCatalog(doc, null), [
    { id: "a", title: "A", url: "https://seller.example/v1/a", tool: "http:seller.example" },
    { id: "b", title: "b", url: "https://seller.example:8443/v1/b", tool: "http:seller.example:8443" },
  ]);
  assert.deepEqual(tasksFromCatalog(doc, ["b"]).map((t) => t.id), ["b"]);
  for (const bad of [null, undefined, 3, "x", [], {}, { offers: "all" }]) assert.deepEqual(tasksFromCatalog(bad, null), []);
});

test("the command: --verify-breakers, a bounded run, a recording, a clean stop on SIGTERM", async () => {
  const dir = tempDir();
  const breakers = run(["--verify-breakers", "--json"], dir);
  assert.equal(breakers.code, 0, breakers.stderr);
  const report = JSON.parse(breakers.stdout);
  assert.deepEqual([report.ok, report.layersProven, report.totalSignatures, report.totalSellerPayments], [true, [1, 2, 3, 4, 5, 6], 0, 0]);
  assert.match(run(["--verify-breakers"], dir).stdout, /RESULT: every pre-sign layer refused with 0 signatures/);

  const bounded = run(["run", "--cycles", "1", "--interval", "0", "--loopback-port", "0", "--json"], dir);
  assert.equal(bounded.code, 0, bounded.stderr);
  const events = bounded.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((e) => e.event), ["step", "step", "step", "step", "step", "step", "heartbeat"]);
  assert.equal(events.at(-1).heartbeat.settledUsd, "0.03");
  for (const file of ["agent.json", "mandate.json"]) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o077, file === "agent.json" ? 0 : fs.statSync(path.join(dir, file)).mode & 0o077);
  assert.equal(bounded.stdout.includes(JSON.parse(fs.readFileSync(path.join(dir, "agent.json"), "utf8")).seed ?? "\u0000"), false);

  const recordDir = tempDir();
  const recorded = run(["run", "--dir", recordDir, "--loopback-port", "0", "--record", path.join(recordDir, "session.json"), "--source-commit", "b".repeat(40)], dir);
  assert.equal(recorded.code, 0, recorded.stderr);
  const session = JSON.parse(fs.readFileSync(path.join(recordDir, "session.json"), "utf8"));
  assert.deepEqual([session.steps.length, session.totals.signatures, session.source.commit, "payerSignatures" in session], [8, 2, "b".repeat(40), false]);

  for (const [args, message] of [
    [["explode"], /unknown command/],
    [["run", "--cycles", "0"], /at least 1/],
    [["run", "--live"], /needs --mandate/],
    [["run", "--live", "--record", "x.json"], /loopback only/],
    [["run", "--pay-module", "pay.mjs", "--loopback-port", "0"], /live mode/],
  ]) {
    const out = run(args, tempDir());
    assert.equal(out.code, 2, args.join(" "));
    assert.match(out.stderr, message);
  }

  // The daemon: runs until SIGTERM, then releases its lock and exits 0.
  const daemonDir = tempDir();
  const child = spawn(process.execPath, [CLI, "run", "--dir", daemonDir, "--interval", "3600", "--loopback-port", "0", "--control-port", "0"], { env: env(), stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const deadline = Date.now() + 20_000;
  while (!/heartbeat 1:/.test(stderr) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.match(stderr, /heartbeat 1: decisions 6, refusals 3, settled 0\.03 USDC/);
  child.kill("SIGTERM");
  assert.equal(await exited, 0, stderr);
  assert.match(stderr, /stopped after 1 cycle\(s\): stopped/);
  assert.equal(fs.existsSync(path.join(daemonDir, ".twzrd-mandate", "mandate.lock")), false);
});
