// Regression tests for the 2026-11-17 pre-release security review of
// @twzrd1111/mandate: one test (or more) per finding, numbered as in the
// review. Each one failed against the code the review read and passes now.
// Nothing here leaves 127.0.0.1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  LOOPBACK_SELLER,
  RECEIPT_LEAVES_FILE,
  STATE_FILES,
  VERSION,
  checkReceipt,
  createHttpUpstream,
  createMandateRuntime,
  createMcpGateway,
  emitHeartbeat,
  issueMandate,
  keyFromSeed,
  mandateStateDir,
  readCapped,
  recordedReceipt,
  redactUrls,
  startSidecar,
  unsafeMessageKey,
  verifyDecisionLedger,
  verifyMandate,
  writeMandateFile,
} from "../dist/index.js";
import { makeRig, tempDir } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECEIPT = recordedReceipt();
const ISSUED_AT = (RECEIPT.preimage ?? RECEIPT.twzrd_receipt?.preimage).timestamp_unix;
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function issueSelf(key, extra = {}) {
  return issueMandate({
    issuerMode: "self-mandated",
    issuerKey: key,
    maxPerCallUsd: "0.05",
    dailyCeilingUsd: "1.00",
    allowedChains: ["solana"],
    minTrustScore: 75,
    allowedTools: ["inference"],
    requireV7Receipt: true,
    requireMerkleInclusion: true,
    killswitchDir: ".state",
    lifetimeMs: 3_600_000,
    ...extra,
  });
}

test("1: a settlement report below the signed amount is not recorded as the spend; the signed amount is, and spending pauses", async () => {
  const rig = await makeRig({ mandate: { maxPerCallUsd: "0.05", hourlyCeilingUsd: "0.05", dailyCeilingUsd: "1.00" } });
  try {
    rig.world.product("x").priceMicro = 50_000;
    rig.world.product("x").billMicro = 1;
    const first = await rig.buy("x");
    assert.deepEqual([first.outcome, first.settledUsd, first.refusal.code], ["violation", "0.05", "settlement_tripped"]);
    // The hour window is full at the signed amount, whatever the seller said.
    assert.equal(rig.runtime.status().spend.hourUsd, "0.05");
    await rig.runtime.resume("operator looked");
    const second = await rig.buy("x");
    assert.deepEqual([second.outcome, second.refusal.code, second.signatures], ["refused", "budget_exceeded", 0]);
    assert.equal(rig.world.paidCount, 1);
  } finally {
    await rig.close();
  }
});

test("2: the spend and a pending line are on disk before the payment leaves", async () => {
  const rig = await makeRig();
  try {
    let seen = null;
    rig.world.hook = (event) => {
      if (event !== "payment:ok") return;
      const rows = fs.readFileSync(path.join(rig.stateDir, STATE_FILES.decisionLedger), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const spend = fs.readFileSync(path.join(rig.stateDir, STATE_FILES.toolLedger), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      seen = { last: rows.at(-1), toolSpend: spend.filter((r) => r.model === "(tool)" && r.allowed === true).map((r) => r.cost_usd) };
    };
    const result = await rig.buy("ok");
    assert.equal(result.outcome, "settled");
    assert.deepEqual([seen.last.outcome, seen.last.code, seen.last.settledUsd, seen.last.signatures], ["pending", "payment_sent", "0.01", 1]);
    assert.deepEqual(seen.toolSpend.map(Number), [0.01]);
    assert.equal(result.record.ref, seen.last.seq);
  } finally {
    await rig.close();
  }
});

test("2: a process killed after the seller took the payment: the restart records it, keeps the spend and pauses", async () => {
  const stateDir = tempDir();
  const seed = crypto.randomBytes(32);
  const mandateId = `mnd_${crypto.randomBytes(16).toString("hex")}`;
  const now = Date.now();
  const child = spawnSync(process.execPath, [path.join(HERE, "fixtures", "crash-after-payment.mjs"), stateDir, seed.toString("hex"), mandateId, String(now)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split("\n")[0]), { paidCount: 1, receivedMicro: 50_000 });

  const again = await makeRig({
    stateDir,
    agentKey: keyFromSeed(seed),
    now: now + 1000,
    mandate: { mandateId, maxPerCallUsd: "0.05", hourlyCeilingUsd: "0.05", dailyCeilingUsd: "1.00" },
  });
  try {
    const rows = again.runtime.ledger.tail(10);
    assert.deepEqual(
      rows.map((r) => [r.outcome, r.code, r.settledUsd, r.ref]),
      [
        ["pending", "payment_sent", "0.05", null],
        ["violation", "payment_unresolved", "0.05", 1],
      ],
    );
    const status = again.runtime.status();
    assert.deepEqual([status.spend.hourUsd, status.counters.settled + status.counters.violations, status.halt.active], ["0.05", 1, true]);
    const next = await again.buy("x");
    assert.deepEqual([next.outcome, next.refusal.code, next.signatures], ["refused", "payment_gate_halt", 0]);
  } finally {
    await again.close();
  }
});

test("3: a violation pause lasts until the operator resumes, not an hour", async () => {
  const rig = await makeRig({ mandate: { lifetimeMs: 30 * 86_400_000 } });
  const real = Date.now;
  try {
    rig.world.product("ok").billMicro = 40_000;
    assert.equal((await rig.buy("ok")).outcome, "violation");
    rig.clock.now += 3 * 86_400_000;
    Date.now = () => rig.clock.now;
    const later = await rig.buy("ok");
    assert.deepEqual([later.outcome, later.refusal.code], ["refused", "payment_gate_halt"]);
    Date.now = real;
    await rig.runtime.resume("operator looked");
    rig.world.product("ok").billMicro = null;
    Date.now = () => rig.clock.now;
    assert.equal((await rig.buy("ok")).outcome, "settled");
  } finally {
    Date.now = real;
    await rig.close();
  }
});

test("4: an MCP message another decoder could read differently is refused and never reaches the upstream", async () => {
  // Unit: the shapes from the review, and the ones that stay allowed.
  assert.equal(unsafeMessageKey({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", Name: "unlisted_tool" } }), "Name");
  assert.equal(unsafeMessageKey({ jsonrpc: "2.0", id: 1, method: "ping", Method: "tools/call" }), "Method");
  assert.equal(unsafeMessageKey({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", argumentſ: {} } }), "argumentſ");
  assert.equal(unsafeMessageKey([{ jsonrpc: "2.0", id: 1, METHOD: "tools/call" }]), "METHOD");
  assert.equal(unsafeMessageKey({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { q: 1, Q: 2 } } }), "Q");
  assert.equal(unsafeMessageKey({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { Query: "x" } } }), null);

  const rig = await makeRig();
  const mcp = createMcpGateway(rig.runtime, createHttpUpstream(rig.world.mcpUrl, { fetch: rig.guard.fetch }));
  const sidecar = await startSidecar({ runtime: rig.runtime, version: VERSION, port: 0, mcp });
  try {
    const bodies = [
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","Name":"unlisted_tool","arguments":{}}}',
      '{"jsonrpc":"2.0","id":3,"method":"ping","Method":"tools/call","params":{"name":"unlisted_tool","arguments":{}}}',
    ];
    for (const body of bodies) {
      const before = rig.runtime.ledger.count();
      const resp = await fetch(`${sidecar.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body });
      assert.equal(resp.status, 400, body);
      assert.equal((await resp.json()).error.code, -32600);
      assert.equal(rig.runtime.ledger.count(), before);
    }
    assert.deepEqual(rig.world.hits.filter((h) => h.startsWith("mcp:")), []);
    // Duplicate keys: the upstream gets the message the proxy decided on (the last "name"), never the raw bytes.
    const dup = await fetch(`${sidecar.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"unlisted_tool","name":"echo","arguments":{}}}',
    });
    assert.equal(dup.status, 200);
    assert.deepEqual(rig.runtime.ledger.tail(1).map((r) => [r.tool, r.outcome]), [["mcp:echo", "free"]]);
  } finally {
    await sidecar.close();
    mcp.close();
    await rig.close();
  }
});

test("6: with an operator issuer pinned, a mandate the agent signed for itself is refused unless allowed", () => {
  const operator = keyFromSeed(crypto.randomBytes(32));
  const agent = keyFromSeed(crypto.randomBytes(32));
  const self = issueSelf(agent, { dailyCeilingUsd: "50.00" });
  const pinned = verifyMandate(self, { trustedIssuers: [operator.publicKey], heldAgentKey: agent.publicKey });
  assert.deepEqual([pinned.ok, pinned.code], [false, "mandate_issuer_untrusted"]);
  assert.match(pinned.detail, /self-mandates are off/);
  assert.equal(verifyMandate(self, { trustedIssuers: [operator.publicKey], heldAgentKey: agent.publicKey, allowSelfMandate: true }).ok, true);
  assert.equal(verifyMandate(self, { heldAgentKey: agent.publicKey }).ok, true);
  assert.equal(verifyMandate(self, { trustedIssuers: [agent.publicKey] }).ok, true);
});

test("7: an old receipt, a repeated receipt and a receipt about a query-string wallet are refused", async () => {
  // Unit: the age bound reads the signed timestamp.
  const at = (seconds) => ({ subjects: [LOOPBACK_SELLER], requireV7: true, maxAgeSeconds: 900, now: (ISSUED_AT + seconds) * 1000 });
  assert.equal(checkReceipt(RECEIPT, at(60)).status, "verified");
  assert.match(checkReceipt(RECEIPT, at(901)).detail, /older than the 900 s/);
  assert.match(checkReceipt(RECEIPT, at(-301)).detail, /dated in the future/);
  const fresh = checkReceipt(RECEIPT, at(60));
  assert.match(checkReceipt(RECEIPT, { ...at(60), seenLeaves: new Set([fresh.leaf]) }).detail, /already accepted/);

  // Through the runtime, with the defaults the loopback rig turns off. The
  // rig clock is set back to the receipt's issue date; the gate reads Date.now.
  const checks = { receiptMaxAgeSeconds: 900, refuseReceiptReplay: true };
  const real = Date.now;
  const stale = await makeRig({ now: (ISSUED_AT + 86_400) * 1000, runtime: checks });
  Date.now = () => stale.clock.now;
  try {
    const result = await stale.buy("ok");
    assert.deepEqual([result.outcome, result.refusal.code, result.receipt.status], ["violation", "receipt_invalid", "invalid"]);
  } finally {
    Date.now = real;
    await stale.close();
  }
  const replay = await makeRig({ now: (ISSUED_AT + 60) * 1000, runtime: checks });
  Date.now = () => replay.clock.now;
  try {
    assert.equal((await replay.buy("ok")).outcome, "settled");
    assert.equal(fs.readFileSync(path.join(replay.stateDir, RECEIPT_LEAVES_FILE), "utf8").trim(), fresh.leaf);
    const again = await replay.buy("ok");
    assert.deepEqual([again.outcome, again.refusal.code], ["violation", "receipt_invalid"]);
    assert.match(again.record.detail, /already accepted/);
  } finally {
    Date.now = real;
    await replay.close();
  }
  // The seller is paid at another wallet; naming the receipt's wallet in the query no longer widens the check.
  const other = await makeRig();
  try {
    other.world.product("x").payTo = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const named = await other.runtime.call({ tool: other.tool, url: `${other.world.url("x")}?ref=${LOOPBACK_SELLER}` });
    assert.deepEqual([named.outcome, named.refusal.code], ["violation", "receipt_invalid"]);
    assert.match(named.receipt.detail, /did not name/);
  } finally {
    await other.close();
  }
});

test("8: the body cap stops reading at the limit instead of after buffering", async () => {
  await assert.rejects(readCapped(new Response("x".repeat(10), { headers: { "content-length": "10" } }), 5), /larger than 5 bytes/);
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(1024));
      if (pulled > 10_000) controller.close();
    },
  });
  await assert.rejects(readCapped(new Response(endless), 4096), /larger than 4096 bytes/);
  assert.ok(pulled < 10, `read ${pulled} chunks of an oversized body`);
  assert.equal(Buffer.from(await readCapped(new Response("hello"), 5)).toString(), "hello");
});

test("9: an agent's own Authorization: Payment header is dropped, not taken for a payment the runtime made", async () => {
  const rig = await makeRig();
  try {
    const result = await rig.buy("ok", { headers: { authorization: "Payment abc" } });
    assert.deepEqual([result.outcome, result.signatures, rig.payer.signatures, rig.world.paidCount], ["settled", 1, 1, 1]);
    assert.equal(rig.runtime.status().halt.active, false);
  } finally {
    await rig.close();
  }
});

test("10: a ledger rewritten under a signed heartbeat is refused on reopen", async () => {
  const rig = await makeRig();
  const file = path.join(rig.stateDir, STATE_FILES.decisionLedger);
  rig.world.product("gratis").free = true;
  await rig.buy("gratis");
  await rig.buy("a");
  emitHeartbeat(rig.runtime, rig.clock.now);
  await rig.close();
  // Drop the paid lines, renumber, recompute every prev: the chain alone still verifies.
  const kept = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.outcome === "free");
  let prev = "genesis";
  const out = kept.map((row, i) => {
    const line = JSON.stringify({ ...row, seq: i + 1, prev });
    prev = sha(line);
    return line;
  });
  fs.writeFileSync(file, `${out.join("\n")}\n`);
  assert.equal(verifyDecisionLedger(file).ok, true);
  await assert.rejects(() => makeRig({ stateDir: rig.stateDir, agentKey: rig.agentKey }), /rewritten or cut short/);
});

test("11: kill and resume follow killswitchDir only from a mandate whose signature verifies", () => {
  const dir = tempDir();
  const agent = keyFromSeed(crypto.randomBytes(32));
  const mandate = issueSelf(agent);
  const file = writeMandateFile(path.join(dir, "mandate.json"), mandate);
  const good = mandateStateDir(file);
  assert.deepEqual([good.ok, good.stateDir], [true, path.join(dir, ".state")]);
  fs.writeFileSync(file, JSON.stringify({ ...mandate, killswitchDir: "../elsewhere" }));
  const edited = mandateStateDir(file);
  assert.equal(edited.ok, false);
  assert.match(edited.detail, /does not verify/);
});

test("12: a target with credentials is refused, and error text on the ledger carries no query or userinfo", async () => {
  const rig = await makeRig();
  try {
    const target = new URL(rig.world.url("ok"));
    target.username = "user";
    target.password = "hunter2";
    const withCreds = await rig.runtime.call({ tool: rig.tool, url: target.href });
    assert.deepEqual([withCreds.outcome, withCreds.record.code], ["error", "bad_target"]);
    const closed = await rig.runtime.call({ tool: "http:127.0.0.1:1", url: "http://127.0.0.1:1/x?api_key=SECRET" });
    assert.equal(closed.record.code === "tool_not_allowed" || closed.record.code === "upstream_error", true);
    const text = fs.readFileSync(path.join(rig.stateDir, STATE_FILES.decisionLedger), "utf8");
    assert.equal(text.includes("hunter2"), false);
    assert.equal(text.includes("SECRET"), false);
  } finally {
    await rig.close();
  }
  assert.equal(redactUrls("fetch failed for https://u:p@host.example/a/b?key=SECRET#f (ECONNREFUSED)"), "fetch failed for https://host.example/a/b (ECONNREFUSED)");
});

test("5: the inference meter refuses a request without the sidecar's token, and does not start without the inference tool", async () => {
  // The positive path (through the sidecar) is covered in inference.test.mjs.
  const rig = await makeRig({ mandate: { allowedTools: ["mcp:echo"] } });
  try {
    const { startInferenceMeter } = await import("../dist/index.js");
    await assert.rejects(
      startInferenceMeter({ runtime: rig.runtime, expiresAtMs: rig.expiresAtMs, upstreamBaseUrl: "http://127.0.0.1:9/v1", freeModels: ["m"] }),
      /does not allow the tool "inference"/,
    );
  } finally {
    await rig.close();
  }
  const metered = await makeRig();
  const { startInferenceMeter } = await import("../dist/index.js");
  const meter = await startInferenceMeter({ runtime: metered.runtime, expiresAtMs: metered.expiresAtMs, upstreamBaseUrl: "http://127.0.0.1:9/v1", freeModels: ["m"] });
  try {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const direct = await fetch(`http://127.0.0.1:${meter.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(direct.status, 403);
    const wrong = await fetch(`http://127.0.0.1:${meter.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-twzrd-meter-token": "x".repeat(43) },
      body,
    });
    assert.equal(wrong.status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${meter.port}/healthz`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${meter.port}/healthz`, { headers: { "x-twzrd-meter-token": meter.token } })).status, 200);
  } finally {
    meter.close();
    await metered.close();
  }
});
