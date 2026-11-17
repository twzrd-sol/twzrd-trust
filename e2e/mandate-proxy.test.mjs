// The mandate sidecar, end to end: `mandate serve` as a child process, a
// paid call through each of its routes across all seven stages, then the
// adversarial vectors. See mandate-lib.mjs.
//
//   1 agent           asks the sidecar; the sidecar reads the seller's quote from its 402
//   2 tool guard      the mandate's allow-list, per-call cap and budget hold
//   3 trust gate      seller preflight and wash check
//   4 budget          the gate's own ceiling on its own ledger
//   5 payment         the pay module pays the one approved offer, once
//   6 receipt         V7 under the pinned key, and inclusion in the receipt log
//   7 reconciliation  three ledgers verify and agree with what the seller was paid
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { writePauseSentinel } from "../twzrd-x402-gate/dist/index.js";
import { createLoopbackPayer, issueMandate, startLoopbackWorld } from "../twzrd-mandate/dist/index.js";
import { DEAR_RATES, MANDATE_CLI, eventually, micro, reconcile, runCli, startServe, startStack, verifyReceiptTwice, writeFixtureDir } from "./mandate-lib.mjs";

const refusal = async (response) => (await response.json()).error;

// ---- stages ----------------------------------------------------------------

test("stages 1-7 over /pay: one paid call passes every control and all the records agree", async () => {
  const stack = await startStack();
  try {
    const response = await stack.pay("lookup");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.answer, 42);

    // 1-5: one quote read, the seller screened, one payment sent. The seller saw the runtime's
    // unpaid request, the payer's unpaid request, and the paid one.
    assert.deepEqual(stack.world.hits.filter((h) => h.endsWith(":lookup")), ["challenge:lookup", "challenge:lookup", "payment:lookup"]);
    assert.ok(stack.world.hits.indexOf("preflight") < stack.world.hits.indexOf("payment:lookup"), "the seller was paid before it was screened");
    assert.ok(stack.world.hits.includes("merchant_card"));
    assert.deepEqual([stack.signatures(), stack.world.paidCount, stack.world.receivedMicro], [1, 1, 10_000]);

    // 6: the receipt the agent was handed verifies under the pinned key with both verifiers.
    const receipt = verifyReceiptTwice(body.receipt);
    assert.deepEqual([receipt.ok, receipt.subject], [true, stack.world.product("lookup").payTo]);

    // 7: the three ledgers chain, agree with each other, and agree with the seller.
    const books = reconcile(stack.stateDir, stack.world, stack.mandate.mandateId);
    assert.deepEqual(books.mismatches, []);
    assert.deepEqual([books.decisionMicro, books.toolMicro, books.gateMicro, books.sellerMicro, books.signatures], [10_000, 10_000, 10_000, 10_000, 1]);
    const [row] = books.rows;
    assert.deepEqual([row.outcome, row.quotedUsd, row.settledUsd, row.signatures, row.receipt, row.inclusion], ["settled", "0.01", "0.01", 1, "verified", "proven"]);

    const status = await stack.status();
    assert.deepEqual([status.counters.settled, status.counters.settledUsd, status.spend.remainingDayUsd, status.ledger.head], [1, "0.01", "0.99", books.head]);
  } finally {
    await stack.close();
  }
});

test("stages 1-7 over /mcp: a paid MCP tool is settled in band, once, within the mandate", async () => {
  const stack = await startStack();
  try {
    stack.world.product("mcp").priceMicro = 20_000;
    const paid = await stack.mcp("paid_lookup");
    assert.equal(paid.result.isError ?? false, false, JSON.stringify(paid));
    assert.equal(verifyReceiptTwice(paid.result.structuredContent.receipt).ok, true);
    assert.deepEqual([stack.signatures(), stack.world.paidCount, stack.world.receivedMicro], [1, 1, 20_000]);
    // A free tool passes through; a tool the mandate does not name never reaches the upstream.
    const before = stack.world.hits.length;
    const unlisted = await stack.mcp("unlisted_tool", 2);
    assert.deepEqual([unlisted.result.isError, unlisted.result.structuredContent.twzrd_mandate.code, unlisted.result.structuredContent.twzrd_mandate.signatures], [true, "tool_not_allowed", 0]);
    assert.equal(stack.world.hits.length, before);
    assert.equal((await stack.mcp("echo", 3)).result.isError ?? false, false);

    const books = reconcile(stack.stateDir, stack.world, stack.mandate.mandateId);
    assert.deepEqual(books.mismatches, []);
    assert.deepEqual([books.decisionMicro, books.sellerMicro, books.signatures], [20_000, 20_000, 1]);
    assert.deepEqual(books.rows.map((r) => [r.tool, r.outcome]), [["mcp:paid_lookup", "settled"], ["mcp:unlisted_tool", "refused"], ["mcp:echo", "free"]]);
  } finally {
    await stack.close();
  }
});

test("stages 1-7 over /v1: an inference call is metered against the same mandate and the same budget", async () => {
  const stack = await startStack({ maxPerCallUsd: "0.50", hourlyCeilingUsd: "1.00", dailyCeilingUsd: "1.00" }, { inference: true });
  try {
    const answer = await stack.chat();
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).choices[0].message.content, "ok");
    // 1000 prompt tokens at 1 USD per million plus 500 completion tokens at 2 USD per million: 0.002 USD.
    assert.ok(await eventually(async () => (await stack.status()).spend.dayUsd !== "0"));
    const spent = micro((await stack.status()).spend.dayUsd);
    assert.equal(spent, 2000);
    // A paid tool call now draws on what inference left.
    assert.equal((await stack.pay("lookup")).status, 200);
    assert.equal(micro((await stack.status()).spend.dayUsd), 12_000);
    assert.equal(stack.upstream.requests, 1);
  } finally {
    await stack.close();
  }
});

// ---- adversarial vectors ---------------------------------------------------

test("vector: an expired mandate. The sidecar will not start on one, and one that expires while running stops paying", async () => {
  const world = await startLoopbackWorld(createLoopbackPayer().publicKey);
  try {
    // Already expired at start.
    const stale = writeFixtureDir(world, { lifetimeMs: 60_000, now: Date.now() - 3_600_000 });
    const refused = startServe(stale.dir, ["--agent-key", "agent.json", "--pay-module", "pay.mjs", "--intel-base", world.intelBase]);
    await assert.rejects(refused.ready, /mandate_expired/);
    assert.notEqual(await refused.exited, 0);
    assert.equal(runCli(MANDATE_CLI, ["verify", "--agent-key", "agent.json"], stale.dir).code, 1);

    // Expires three seconds after it starts.
    const brief = writeFixtureDir(world, { lifetimeMs: 3000 });
    const serve = startServe(brief.dir, ["--agent-key", "agent.json", "--pay-module", "pay.mjs", "--intel-base", world.intelBase]);
    const url = await serve.ready;
    try {
      assert.equal((await fetch(`${url}/pay/${world.url("lookup")}`)).status, 200);
      const paidBefore = world.paidCount;
      const hitsBefore = world.hits.length;
      assert.ok(await eventually(async () => (await fetch(`${url}/health`).then((r) => r.json())).expired === true, 8000));
      const late = await fetch(`${url}/pay/${world.url("lookup")}`);
      assert.equal(late.status, 403);
      const error = await refusal(late);
      assert.deepEqual([error.layer, error.code, error.signatures], [1, "mandate_expired", 0]);
      assert.deepEqual([world.paidCount, world.hits.length], [paidBefore, hitsBefore], "an expired mandate still reached the seller");
      const books = reconcile(brief.stateDir, world, brief.mandate.mandateId);
      assert.deepEqual([books.mismatches, books.signatures, books.sellerMicro], [[], 1, 10_000]);
    } finally {
      await serve.stop();
    }
  } finally {
    await world.close();
  }
});

test("vector: a tampered mandate. An edited limit, a borrowed signature or a missing signature stops the sidecar at start", async () => {
  const world = await startLoopbackWorld(createLoopbackPayer().publicKey);
  try {
    const fixture = writeFixtureDir(world);
    const file = path.join(fixture.dir, "mandate.json");
    const good = JSON.parse(fs.readFileSync(file, "utf8"));
    const donor = issueMandate({ issuerMode: "self-mandated", issuerKey: fixture.agentKey, maxPerCallUsd: "5.00", dailyCeilingUsd: "500.00", allowedChains: ["solana"], minTrustScore: 0, allowedTools: [fixture.tool], killswitchDir: ".twzrd-mandate", lifetimeMs: 3_600_000 });
    const flipped = Buffer.from(good.signature.value, "base64");
    flipped[10] ^= 1;
    const { signature: _dropped, ...unsigned } = good;
    const cases = [
      ["the daily ceiling raised", { ...good, limits: { ...good.limits, dailyCeilingUsd: "1000.00" } }, /mandate_signature_invalid/],
      ["the trust floor lowered", { ...good, minTrustScore: 0 }, /mandate_signature_invalid/],
      ["a tool added", { ...good, allowedTools: [...good.allowedTools, "mcp:unlisted_tool"] }, /mandate_signature_invalid/],
      ["the expiry pushed out", { ...good, expiresAt: "2027-06-01T00:00:00Z" }, /mandate_signature_invalid/],
      ["another mandate's signature", { ...good, signature: donor.signature }, /mandate_signature_invalid/],
      ["one bit of the signature flipped", { ...good, signature: { ...good.signature, value: flipped.toString("base64") } }, /mandate_signature_invalid/],
      ["the signature removed", unsigned, /mandate_unsigned/],
      ["an unknown member added", { ...good, unlimited: true }, /mandate_malformed/],
      ["not JSON", "{", /mandate_malformed/],
    ];
    for (const [name, doc, expected] of cases) {
      fs.writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
      const serve = startServe(fixture.dir, ["--agent-key", "agent.json", "--pay-module", "pay.mjs", "--intel-base", world.intelBase]);
      await assert.rejects(serve.ready, expected, name);
      assert.notEqual(await serve.exited, 0, name);
    }
    assert.deepEqual([world.hits.length, world.paidCount], [0, 0]);
    // The untouched file still starts.
    fs.writeFileSync(file, JSON.stringify(good));
    const serve = startServe(fixture.dir, ["--agent-key", "agent.json", "--pay-module", "pay.mjs", "--intel-base", world.intelBase]);
    await serve.ready;
    await serve.stop();
  } finally {
    await world.close();
  }
});

test("vector: a 402 header that is not canonical base64 is refused before the payer sees it", async () => {
  const stack = await startStack();
  try {
    stack.world.product("loose").challenge = "noncanonical-header";
    stack.world.product("garbage").challenge = "garbage";
    stack.world.product("mpp").challenge = "mpp";
    stack.world.product("strict").challenge = "header";
    for (const name of ["loose", "garbage", "mpp"]) {
      const response = await stack.pay(name);
      assert.equal(response.status, 403, name);
      const error = await refusal(response);
      assert.deepEqual([error.layer, error.code, error.signatures], [6, "payment_required_unreadable", 0], name);
    }
    // The same offer in a canonical header is paid.
    assert.equal((await stack.pay("strict")).status, 200);
    assert.deepEqual([stack.signatures(), stack.world.paidCount], [1, 1]);
    assert.equal(stack.world.hits.filter((h) => h.startsWith("payment:")).join(), "payment:strict");
    assert.deepEqual(reconcile(stack.stateDir, stack.world, stack.mandate.mandateId).mismatches, []);
  } finally {
    await stack.close();
  }
});

test("vector: a seller that takes the payment and answers an error is counted in full, and spending stops", async () => {
  const stack = await startStack();
  try {
    stack.world.product("broken").afterPayStatus = 500;
    const response = await stack.pay("broken");
    assert.equal(response.status, 502);
    const answer = await response.json();
    const error = answer.error;
    assert.deepEqual([error.code, error.signatures], ["paid_call_failed", 1]);
    // The agent gets the refusal and nothing the seller sent.
    assert.deepEqual([Object.keys(answer), "answer" in error, "receipt" in error], [["error"], false, false]);

    // The money left, so every ledger counts it.
    const books = reconcile(stack.stateDir, stack.world, stack.mandate.mandateId);
    assert.deepEqual(books.mismatches, []);
    assert.deepEqual([books.decisionMicro, books.toolMicro, books.gateMicro, books.sellerMicro], [10_000, 10_000, 10_000, 10_000]);
    assert.deepEqual(books.rows.filter((r) => r.outcome !== "control").map((r) => [r.outcome, r.code, r.settledUsd]), [["violation", "paid_call_failed", "0.01"]]);
    assert.equal((await stack.status()).spend.remainingDayUsd, "0.99");

    // Spending is paused for everything, until an operator resumes with the control token.
    const next = await stack.pay("lookup");
    assert.deepEqual([next.status, (await refusal(next)).code], [403, "payment_gate_halt"]);
    assert.equal((await stack.mcp("paid_lookup")).result.structuredContent.twzrd_mandate.code, "payment_gate_halt");
    assert.equal(stack.signatures(), 1);
    assert.equal((await fetch(`${stack.url}/mandate/resume`, { method: "POST" })).status, 401);
    assert.equal((await stack.resume()).status, 200);
    assert.equal((await stack.pay("lookup")).status, 200);
    assert.deepEqual(reconcile(stack.stateDir, stack.world, stack.mandate.mandateId).mismatches, []);
  } finally {
    await stack.close();
  }
});

test("vector: a malformed usage block on /v1 is billed at the reserved worst case, never at zero", async () => {
  const vectors = [undefined, null, "lots", [], {}, { prompt_tokens: "many", completion_tokens: 5 }, { prompt_tokens: -5, completion_tokens: -5 }, { prompt_tokens: 1.5, completion_tokens: Number.NaN }];
  const stack = await startStack({ maxPerCallUsd: "0.50", hourlyCeilingUsd: "5.00", dailyCeilingUsd: "5.00" }, { inference: true, rates: DEAR_RATES });
  try {
    let before = 0;
    for (const usage of vectors) {
      stack.upstream.usage = usage;
      const answer = await stack.chat();
      assert.equal(answer.status, 200, JSON.stringify(usage));
      await answer.arrayBuffer();
      assert.ok(await eventually(async () => micro((await stack.status()).spend.dayUsd) > before), `nothing was recorded for usage ${JSON.stringify(usage)}`);
      const now = micro((await stack.status()).spend.dayUsd);
      // 100 output tokens at 2000 USD per million reserve 0.20 USD plus the prompt; the per-call cap is 0.50.
      assert.ok(now - before >= 200_000 && now - before <= 500_000, `usage ${JSON.stringify(usage)} was billed ${now - before} micro`);
      before = now;
    }
    // A request priced over the per-call cap never reaches the upstream.
    const requests = stack.upstream.requests;
    const big = await stack.chat({ max_tokens: 1_000_000 });
    assert.equal(big.status >= 400, true);
    assert.equal(stack.upstream.requests, requests);
  } finally {
    await stack.close();
  }
});

test("vector: twenty calls racing for a budget that holds five", async () => {
  const stack = await startStack({ maxPerCallUsd: "0.05", dailyCeilingUsd: "0.25" });
  try {
    stack.world.product("race").priceMicro = 50_000;
    const responses = await Promise.all(Array.from({ length: 20 }, () => stack.pay("race")));
    const settled = responses.filter((r) => r.status === 200).length;
    const errors = await Promise.all(responses.filter((r) => r.status !== 200).map(refusal));
    assert.equal(settled, 5);
    assert.deepEqual([...new Set(errors.map((e) => `${e.layer}:${e.code}:${e.signatures}`))], ["4:budget_exceeded:0"]);
    assert.deepEqual([stack.signatures(), stack.world.paidCount, stack.world.receivedMicro], [5, 5, 250_000]);
    const books = reconcile(stack.stateDir, stack.world, stack.mandate.mandateId);
    assert.deepEqual(books.mismatches, []);
    assert.deepEqual([books.decisionMicro, books.toolMicro, books.gateMicro, books.rows.length], [250_000, 250_000, 250_000, 20]);
    assert.equal((await stack.status()).spend.remainingDayUsd, "0");
    // And the over-and-over mix: MCP and HTTP share the one budget.
    assert.equal((await stack.mcp("paid_lookup")).result.structuredContent.twzrd_mandate.code, "budget_exceeded");
  } finally {
    await stack.close();
  }
});

test("vector: .kill and .pause stop every route before anything is signed, and only the control token resumes", async () => {
  const stack = await startStack({}, { inference: true });
  try {
    assert.equal((await stack.pay("lookup")).status, 200);
    assert.equal((await stack.chat()).status, 200);
    const hits = stack.world.hits.length;
    const upstreamRequests = stack.upstream.requests;
    assert.equal(upstreamRequests, 1);

    // .kill, written the way the documentation says: a file in the state directory.
    fs.writeFileSync(path.join(stack.stateDir, ".kill"), "e2e\n");
    const killed = await stack.pay("lookup");
    assert.deepEqual([killed.status, await refusal(killed).then((e) => [e.layer, e.code, e.signatures])], [403, [2, "kill_switch", 0]]);
    assert.equal((await stack.mcp("paid_lookup")).result.structuredContent.twzrd_mandate.code, "kill_switch");
    assert.equal((await stack.mcp("echo", 2)).result.structuredContent.twzrd_mandate.code, "kill_switch");
    const killedChat = await stack.chat();
    assert.deepEqual([killedChat.status, (await refusal(killedChat)).code], [403, "kill_switch"]);
    assert.deepEqual([stack.world.hits.length, stack.upstream.requests, stack.signatures()], [hits, upstreamRequests, 1]);
    assert.equal((await stack.status()).halt.mode, "kill");

    // The agent can reach the port, so the port alone cannot resume.
    assert.equal((await fetch(`${stack.url}/mandate/resume`, { method: "POST", headers: { authorization: "Bearer guess" } })).status, 401);
    assert.equal((await stack.pay("lookup")).status, 403);
    assert.equal((await stack.resume()).status, 200);
    assert.equal((await stack.pay("lookup")).status, 200);

    // .pause, as the payment gate writes it when it trips.
    writePauseSentinel(path.join(stack.stateDir, ".pause"), { reason: "e2e pause", ttlMs: 60_000 });
    const paused = await stack.pay("lookup");
    assert.deepEqual([paused.status, await refusal(paused).then((e) => [e.layer, e.code, e.signatures])], [403, [2, "payment_gate_halt", 0]]);
    const pausedChat = await stack.chat();
    assert.deepEqual([pausedChat.status, (await refusal(pausedChat)).code], [403, "payment_gate_halt"]);
    assert.deepEqual([stack.signatures(), stack.upstream.requests], [2, upstreamRequests]);

    // Kill over the control API needs no token; it is always allowed to stop.
    assert.equal((await stack.resume()).status, 200);
    assert.equal((await fetch(`${stack.url}/mandate/kill`, { method: "POST" })).status, 200);
    assert.equal((await stack.pay("lookup")).status, 403);

    const books = reconcile(stack.stateDir, stack.world, stack.mandate.mandateId);
    assert.deepEqual(books.mismatches, []);
    assert.deepEqual([books.signatures, books.sellerMicro, stack.world.paidCount], [2, 20_000, 2]);
  } finally {
    await stack.close();
  }
});
