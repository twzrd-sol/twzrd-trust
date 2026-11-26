// The three v0 gaps: a purchase is paid at most once inside the dedupe window,
// a signed payment's response bytes are hashed onto its ledger line, and a
// mandate signed with trustScreen "off" makes no trust lookup at all. Every
// check counts the payer's signatures and what the seller was paid.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LOOPBACK_SELLER,
  LOOPBACK_WASH_SELLER,
  STATE_FILES,
  createMandateRuntime,
  MCP_IDEMPOTENCY_META,
  createHttpUpstream,
  createMcpGateway,
  issueMandate,
  keyFromSeed,
  loopbackOnlyFetch,
  parseMandate,
  purchaseKey,
  verifyDecisionLedger,
  verifyMandate,
} from "../dist/index.js";
import { makeRig, tempDir } from "./helpers.mjs";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const rows = (rig) =>
  fs.readFileSync(path.join(rig.stateDir, STATE_FILES.decisionLedger), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const KEY = (k) => ({ headers: { "idempotency-key": k } });

// ---- gap 1: purchase dedupe ---------------------------------------------

test("dedupe: the same purchase twice pays once; the second is refused at layer 4 with nothing signed", async () => {
  const rig = await makeRig();
  try {
    const first = await rig.buy("ok", KEY("k1"));
    assert.equal(first.outcome, "settled");
    const second = await rig.buy("ok", KEY("k1"));
    assert.deepEqual([second.outcome, second.status, second.refusal.layer, second.refusal.code], ["refused", 403, 4, "duplicate_purchase"]);
    assert.equal(second.signatures, 0);
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [1, 1]);
    assert.match(second.refusal.detail, /Idempotency-Key/);
    // The refusal names the same purchase as the pending line and the settled line.
    const ledger = rows(rig);
    const pending = ledger.find((r) => r.outcome === "pending");
    assert.match(pending.dedupeKey, /^[0-9a-f]{64}$/);
    assert.equal(first.record.dedupeKey, pending.dedupeKey);
    assert.equal(second.record.dedupeKey, pending.dedupeKey);
    assert.equal(rig.runtime.status().spend.dayUsd, "0.01");
  } finally {
    await rig.close();
  }
});

test("dedupe: with no Idempotency-Key at all, a retry of the same request is refused", async () => {
  const rig = await makeRig();
  try {
    assert.equal((await rig.buy("ok", { headers: {} })).outcome, "settled");
    assert.equal((await rig.buy("ok", { headers: {} })).refusal?.code, "duplicate_purchase");
    assert.equal(rig.payer.signatures, 1);
  } finally {
    await rig.close();
  }
});

test("dedupe: a different body, query, method or Idempotency-Key is a different purchase", async () => {
  const rig = await makeRig();
  try {
    const url = rig.world.url("ok");
    const enc = (s) => new TextEncoder().encode(s);
    const calls = [
      { url, method: "POST", body: enc("a"), headers: {} },
      { url, method: "POST", body: enc("b"), headers: {} },
      { url: `${url}?q=1`, headers: {} },
      { url: `${url}?q=2`, headers: {} },
      { url, headers: { "Idempotency-Key": "x" } },
      { url, headers: { "idempotency-key": "y" } },
    ];
    for (const c of calls) {
      const r = await rig.runtime.call({ tool: rig.tool, ...c });
      assert.equal(r.outcome, "settled", `${JSON.stringify(c.headers)} ${c.url}: ${r.record.code} ${r.record.detail}`);
    }
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [calls.length, calls.length]);
    // Header names are case-insensitive: "Idempotency-Key: x" again is the same purchase.
    const again = await rig.runtime.call({ tool: rig.tool, url, headers: { "IDEMPOTENCY-KEY": "x" } });
    assert.equal(again.refusal?.code, "duplicate_purchase");
  } finally {
    await rig.close();
  }
});

test("dedupe: after the window the same purchase may be paid again", async () => {
  const rig = await makeRig();
  try {
    assert.equal((await rig.buy("ok", KEY("w"))).outcome, "settled");
    rig.clock.now += 59_000;
    assert.equal((await rig.buy("ok", KEY("w"))).refusal?.code, "duplicate_purchase");
    rig.clock.now += 1_000;
    assert.equal((await rig.buy("ok", KEY("w"))).outcome, "settled");
    assert.equal(rig.payer.signatures, 2);
  } finally {
    await rig.close();
  }
});

test("dedupe: two identical calls in flight together sign exactly once", async () => {
  const rig = await makeRig();
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => rig.buy("ok", KEY("race"))));
    const outcomes = results.map((r) => r.outcome).sort();
    assert.deepEqual(outcomes, ["refused", "refused", "refused", "refused", "settled"]);
    assert.ok(results.filter((r) => r.outcome === "refused").every((r) => r.refusal.code === "duplicate_purchase"));
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [1, 1]);
  } finally {
    await rig.close();
  }
});

test("dedupe: a call that paid nothing blocks nothing; the retry goes through", async () => {
  const rig = await makeRig();
  try {
    rig.world.trustDown = true;
    const refused = await rig.buy("ok", KEY("retry"));
    assert.equal(refused.refusal?.code, "trust_gate_refused");
    rig.world.trustDown = false;
    const retried = await rig.buy("ok", KEY("retry"));
    assert.equal(retried.outcome, "settled", `${retried.record.code} ${retried.record.detail}`);
    assert.equal(rig.payer.signatures, 1);
  } finally {
    await rig.close();
  }
});

test("dedupe: a restart remembers a payment that left inside the window", async () => {
  const rig = await makeRig();
  let reopened;
  try {
    assert.equal((await rig.buy("ok", KEY("restart"))).outcome, "settled");
    rig.runtime.close();
    reopened = createMandateRuntime({
      mandate: rig.mandate,
      expiresAtMs: rig.expiresAtMs,
      stateDir: rig.stateDir,
      intelBase: rig.world.intelBase,
      fetch: rig.guard.fetch,
      agentKey: rig.agentKey,
      now: () => rig.clock.now,
      receiptMaxAgeSeconds: null,
      refuseReceiptReplay: false,
      wrapPay: rig.payer.wrapPay,
    });
    const after = await reopened.call({ tool: rig.tool, url: rig.world.url("ok"), ...KEY("restart") });
    assert.equal(after.refusal?.code, "duplicate_purchase");
    assert.equal(rig.payer.signatures, 1);
  } finally {
    reopened?.close();
    await rig.world.close();
  }
});

test("dedupe: window 0 turns the check off; a bad window refuses to start", async () => {
  const rig = await makeRig({ runtime: { dedupeWindowSeconds: 0 } });
  try {
    assert.equal((await rig.buy("ok", KEY("same"))).outcome, "settled");
    assert.equal((await rig.buy("ok", KEY("same"))).outcome, "settled");
    assert.equal(rig.payer.signatures, 2);
    assert.equal(rig.runtime.status().dedupeWindowSeconds, 0);
  } finally {
    await rig.close();
  }
  for (const bad of [-1, 1.5, 86_401, Number.NaN]) {
    await assert.rejects(makeRig({ runtime: { dedupeWindowSeconds: bad } }), /dedupeWindowSeconds/);
  }
});

test("dedupe: the key covers recipient, chain, asset and amount, and never shows the query", () => {
  const target = new URL("https://seller.example/paid?secret=abc");
  const offer = { payTo: LOOPBACK_SELLER, caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "USDC", amountMicro: 10_000n };
  const base = purchaseKey({ method: "GET" }, target, offer);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.ok(!base.includes("secret"));
  assert.equal(purchaseKey({}, target, offer), base, "GET is the default method");
  for (const change of [{ payTo: LOOPBACK_WASH_SELLER }, { caip2: "eip155:8453" }, { asset: "other" }, { amountMicro: 10_001n }]) {
    assert.notEqual(purchaseKey({ method: "GET" }, target, { ...offer, ...change }), base, JSON.stringify(change, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  }
});

test("dedupe: a paid call slower than the window stays in flight; the retry is refused, and the window runs from the end", async () => {
  let release;
  const held = new Promise((r) => (release = r));
  let paymentsSeen = 0;
  let rigRef;
  const lf = loopbackOnlyFetch();
  const fetchSlow = async (input, init) => {
    if (new Headers(init?.headers).get("x-payment") && ++paymentsSeen === 1) {
      const answer = await lf.fetch(input, init);
      rigRef.clock.now += 61_000; // the seller takes longer than the window to answer
      await held;
      return answer;
    }
    return lf.fetch(input, init);
  };
  const rig = await makeRig({ runtime: { fetch: fetchSlow } });
  rigRef = rig;
  try {
    const first = rig.buy("ok", KEY("slow"));
    while (paymentsSeen < 1) await new Promise((r) => setTimeout(r, 5));
    const retry = await rig.buy("ok", KEY("slow"));
    assert.deepEqual([retry.refusal?.code, retry.signatures], ["duplicate_purchase", 0]);
    assert.match(retry.refusal.detail, /in flight/);
    release();
    assert.equal((await first).outcome, "settled");
    rig.clock.now += 30_000; // 91 s after the claim, 30 s after the call ended
    assert.equal((await rig.buy("ok", KEY("slow"))).refusal?.code, "duplicate_purchase");
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [1, 1]);
  } finally {
    await rig.close();
  }
});

test("dedupe: a stalled call that never pays holds its claim only while in flight; afterwards one retry pays", async () => {
  let fail;
  const stall = new Promise((r) => (fail = r));
  let challenges = 0;
  let rigRef;
  const lf = loopbackOnlyFetch();
  const fetchStall = async (input, init) => {
    if (String(input).includes("/paid/") && !new Headers(init?.headers).get("x-payment") && ++challenges === 2) {
      rigRef.clock.now += 61_000;
      await stall;
      throw new Error("seller reset");
    }
    return lf.fetch(input, init);
  };
  const rig = await makeRig({ runtime: { fetch: fetchStall } });
  rigRef = rig;
  try {
    const first = rig.buy("ok", KEY("stall"));
    while (challenges < 2) await new Promise((r) => setTimeout(r, 5));
    const during = await rig.buy("ok", KEY("stall"));
    assert.deepEqual([during.refusal?.code, during.signatures], ["duplicate_purchase", 0]);
    fail();
    const ended = await first;
    assert.equal(ended.signatures, 0);
    assert.equal((await rig.buy("ok", KEY("stall"))).outcome, "settled");
    assert.equal((await rig.buy("ok", KEY("stall"))).refusal?.code, "duplicate_purchase");
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [1, 1]);
  } finally {
    await rig.close();
  }
});

test("dedupe: a clock stepped back blocks for at most one window", async () => {
  const rig = await makeRig();
  try {
    assert.equal((await rig.buy("ok", KEY("clock"))).outcome, "settled");
    rig.clock.now -= 30_000;
    assert.equal((await rig.buy("ok", KEY("clock"))).refusal?.code, "duplicate_purchase");
    rig.clock.now -= 3_600_000;
    assert.equal((await rig.buy("ok", KEY("clock"))).outcome, "settled");
    assert.equal(rig.payer.signatures, 2);
  } finally {
    await rig.close();
  }
});

test("dedupe over MCP: a retried tools/call with a new JSON-RPC id is the same purchase; _meta names a new one", async () => {
  const rig = await makeRig();
  const gw = createMcpGateway(rig.runtime, createHttpUpstream(rig.world.mcpUrl, { fetch: rig.guard.fetch }));
  const call = (id, args, meta) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "paid_lookup", arguments: args, ...(meta ? { _meta: meta } : {}) } });
  const code = (reply) => reply?.result?.structuredContent?.twzrd_mandate?.code ?? (reply?.result ? "delivered" : reply?.error?.message);
  try {
    assert.equal(code(await gw.handleMessage(call(1, { q: "x", n: 1 }))), "delivered");
    // A retry: new id, a progress token, the arguments in another order.
    assert.equal(code(await gw.handleMessage(call(2, { n: 1, q: "x" }, { progressToken: "p2" }))), "duplicate_purchase");
    assert.equal(rig.payer.signatures, 1);
    // Different arguments, or the twzrd idempotency key in _meta, is a new purchase.
    assert.equal(code(await gw.handleMessage(call(3, { q: "y", n: 1 }))), "delivered");
    assert.equal(code(await gw.handleMessage(call(4, { q: "x", n: 1 }, { [MCP_IDEMPOTENCY_META]: "again-1" }))), "delivered");
    assert.equal(code(await gw.handleMessage(call(5, { q: "x", n: 1 }, { [MCP_IDEMPOTENCY_META]: "again-1" }))), "duplicate_purchase");
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [3, 3]);
  } finally {
    gw.close();
    await rig.close();
  }
});

// ---- gap 2: response bytes bound to the payment ---------------------------

test("receipt binding: the settled line carries the SHA-256 of exactly the bytes handed back", async () => {
  const rig = await makeRig();
  try {
    const result = await rig.buy("ok");
    assert.equal(result.outcome, "settled");
    assert.equal(result.record.responseSha256, sha256(result.body));
    const ledger = rows(rig);
    const pending = ledger.find((r) => r.outcome === "pending");
    assert.equal(pending.responseSha256, undefined, "nothing was received when the pending line was written");
    assert.equal(ledger.at(-1).responseSha256, sha256(result.body));
    assert.equal(ledger.at(-1).ref, pending.seq);
  } finally {
    await rig.close();
  }
});

test("receipt binding: refusals and free calls carry no response hash", async () => {
  const rig = await makeRig();
  try {
    rig.world.product("gratis").free = true;
    assert.equal((await rig.buy("gratis")).record.responseSha256, undefined);
    rig.world.trustDown = true;
    assert.equal((await rig.buy("ok")).record.responseSha256, undefined);
  } finally {
    await rig.close();
  }
});

test("receipt binding: a paid call that trips still records what the payment bought", async () => {
  const rig = await makeRig();
  try {
    rig.world.product("x").billMicro = 1;
    const result = await rig.buy("x");
    assert.deepEqual([result.outcome, result.refusal.code], ["violation", "settlement_tripped"]);
    assert.equal(result.record.responseSha256, sha256(result.body));
  } finally {
    await rig.close();
  }
});

test("receipt binding: editing a recorded response hash breaks the ledger chain at the next line", async () => {
  const rig = await makeRig();
  try {
    await rig.buy("ok");
    await rig.buy("ok");
    const file = path.join(rig.stateDir, STATE_FILES.decisionLedger);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const at = lines.findIndex((l) => JSON.parse(l).responseSha256 !== undefined);
    assert.ok(at >= 0 && at < lines.length - 1);
    const row = JSON.parse(lines[at]);
    row.responseSha256 = "0".repeat(64);
    lines[at] = JSON.stringify(row);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const report = verifyDecisionLedger(file);
    assert.equal(report.ok, false);
    assert.equal(report.breaks[0].line, at + 2);
  } finally {
    await rig.close();
  }
});

// ---- gap 3: trustScreen "off" ---------------------------------------------

const OFF = { minTrustScore: 0, trustScreen: "off", requireV7Receipt: false, requireMerkleInclusion: false };

test("trust screen off: the trust service is down and no lookup is made, yet the payment settles under the caps", async () => {
  const rig = await makeRig({ mandate: OFF });
  try {
    rig.world.trustDown = true;
    const result = await rig.buy("ok");
    assert.equal(result.outcome, "settled", `${result.record.code} ${result.record.detail}`);
    assert.deepEqual([rig.payer.signatures, rig.world.paidCount], [1, 1]);
    assert.deepEqual(
      rig.world.hits.filter((h) => h === "preflight" || h === "merchant_card" || h === "bazaar"),
      [],
      `trust lookups made: ${rig.world.hits.join(", ")}`,
    );
    assert.equal(rig.runtime.status().mandate.trustScreen, "off");
  } finally {
    await rig.close();
  }
});

test("trust screen off: lists, chains, caps and the 402 checks still refuse with nothing signed", async () => {
  const cases = [
    [{ blockedCounterparties: [LOOPBACK_SELLER] }, () => {}, "counterparty_blocked"],
    [{ allowedCounterparties: [LOOPBACK_WASH_SELLER] }, () => {}, "counterparty_not_allowed"],
    [{}, (w) => (w.product("x").network = "solana-devnet"), "chain_not_allowed"],
    [{}, (w) => (w.product("x").priceMicro = 60_000), "per_request_cap"],
    [{}, (w) => (w.product("x").challenge = "garbage"), "payment_required_unreadable"],
  ];
  for (const [mandate, arrange, code] of cases) {
    const rig = await makeRig({ mandate: { ...OFF, ...mandate } });
    try {
      arrange(rig.world);
      const r = await rig.buy("x");
      assert.deepEqual([r.outcome, r.refusal?.code, r.signatures, rig.payer.signatures, rig.world.paidCount], ["refused", code, 0, 0, 0]);
    } finally {
      await rig.close();
    }
  }
});

test("trust screen off: it is what the mandate says, not a default; a required mandate still refuses when trust is down", async () => {
  const rig = await makeRig({ mandate: { minTrustScore: 0 } });
  try {
    rig.world.trustDown = true;
    assert.equal((await rig.buy("ok")).refusal?.code, "trust_gate_refused");
    assert.equal(rig.runtime.status().mandate.trustScreen, "required");
  } finally {
    await rig.close();
  }
});

test("trust screen: schema rules; adding it to a signed mandate breaks the signature", () => {
  const key = keyFromSeed(crypto.randomBytes(32));
  const base = {
    issuerMode: "self-mandated",
    issuerKey: key,
    maxPerCallUsd: "0.05",
    dailyCeilingUsd: "1.00",
    allowedChains: ["solana"],
    allowedTools: ["http:seller.example"],
    killswitchDir: tempDir(),
    lifetimeMs: 3_600_000,
  };
  assert.throws(() => issueMandate({ ...base, minTrustScore: 75, trustScreen: "off" }), /trustScreen "off" needs minTrustScore 0/);
  assert.throws(() => issueMandate({ ...base, minTrustScore: 0, trustScreen: "maybe" }), /trustScreen must be/);
  const off = issueMandate({ ...base, minTrustScore: 0, trustScreen: "off" });
  assert.equal(off.trustScreen, "off");
  assert.equal(verifyMandate(off, { heldAgentKey: key.publicKey }).ok, true);
  const plain = issueMandate({ ...base, minTrustScore: 0 });
  assert.equal(Object.hasOwn(plain, "trustScreen"), false, "an omitted screen leaves the signed bytes as they were");
  const tampered = { ...plain, trustScreen: "off" };
  assert.equal(parseMandate(tampered).ok, true, "structurally fine");
  const verdict = verifyMandate(tampered, { heldAgentKey: key.publicKey });
  assert.deepEqual([verdict.ok, verdict.code], [false, "mandate_signature_invalid"]);
});

test("trust screen: the published JSON Schema names the member and its minTrustScore rule", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../schema/twzrd.mandate.v1.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.trustScreen, { enum: ["required", "off"] });
  assert.ok(!schema.required.includes("trustScreen"), "optional, so older mandates stay valid");
  const rule = schema.allOf.find((r) => r.if?.properties?.trustScreen);
  assert.deepEqual(rule.then, { properties: { minTrustScore: { const: 0 } } });
});

test("trust screen: mandate init --trust-screen off writes it with minTrustScore 0, and refuses a non-zero score", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TWZRD_|KILLSWITCH_)/.test(k)));
  const run = (cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
  const dir = tempDir();
  const ok = run(dir, ["init", "--daily", "1.00", "--trust-screen", "off"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /no trust lookup \(trustScreen off\)/);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, "mandate.json"), "utf8"));
  assert.deepEqual([doc.trustScreen, doc.minTrustScore], ["off", 0]);
  const bad = run(tempDir(), ["init", "--daily", "1.00", "--trust-screen", "off", "--min-trust", "50"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--min-trust must be 0/);
  const typo = run(tempDir(), ["init", "--daily", "1.00", "--trust-screen", "of"]);
  assert.notEqual(typo.status, 0);
});
