/**
 * CLI orchestration behind bin/twzrd-bounty-preflight.js, with fetch and the gate injected.
 * Run: npx tsx --test test/bounty-preflight-cli.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, runBountyPreflight, type EvaluateFn } from "../src/bounty-preflight-cli.js";

const BOARD_URL = "https://deskcrew.io/api/arena/contests";
const PING = "https://deskcrew.io/api/x402/paid/ping";
const PAY_TO = "0xB075aA8206D6De88EDEeD0eE4015a1a33D3659D8";
const DESKCREW = {
  enabled: false, bountiesEnabled: true, agentShare: 0.85,
  bounties: [{ id: "t-1", title: "Refund", bountyUsd: 1, entrants: 4, payoutNetwork: "base", entryFeeUsd: 0.06 }], contests: [],
  economics: { approvalRatePct: 21, decidedCount: 372, openBounties: 1, payouts: { sentCount: 67, sentUsd: 56.14, uniqueWallets: 22 }, decisionLatency: { medianHours: 23.85 } },
};
// Live shape of the DeskCrew ping 402 (2026-09-10): v2 header challenge + v1-style body.
const CHALLENGE = { x402Version: 2, error: "Payment required", accepts: [{ scheme: "exact", network: "eip155:8453", payTo: PAY_TO, amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }] };

function fakeFetch(overrides: Record<string, () => Response> = {}): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    if (overrides[u]) return overrides[u]();
    if (u === BOARD_URL) return new Response(JSON.stringify(DESKCREW), { status: 200, headers: { "content-type": "application/json" } });
    if (u === PING) {
      return new Response(JSON.stringify({ x402Version: 1, error: "Payment required", accepts: [{ ...CHALLENGE.accepts[0], network: "base", maxAmountRequired: "20000" }] }), {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(CHALLENGE)).toString("base64") },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const allowGate: EvaluateFn = async (_url, req) => ({ decision: "warn", approved: true, reason: "thin history", card: {}, trustScore: 45, network: req.network, reputationScored: true, policyAction: "allow" });
const blockGate: EvaluateFn = async () => ({ decision: "block", approved: false, reason: "twzrd_wash_flagged: refuse", card: {}, trustScore: 5, reputationScored: true, policyAction: "block" });
// The live shape for a Base payTo: verdict unknown, policy allow, reputation not scored.
const unscoredGate: EvaluateFn = async (_url, req) => ({ decision: "unknown", approved: true, reason: "unsupported_network_observe", card: {}, trustScore: null, network: req.network, networkSupported: false, reputationScored: false, policyAction: "allow" });

test("parseArgs: defaults and explicit flags; DeskCrew boards default to the paid ping", () => {
  const a = parseArgs(["--board", BOARD_URL, "--assumed-win-prob", "0.2"]);
  assert.deepEqual(a, { boardUrl: BOARD_URL, paidEndpoint: PING, attemptCostUsd: 0.08, maxAttemptUsd: null, assumedWinProb: 0.2, myNetworks: ["solana", "base"], allowUnscored: false });
  const b = parseArgs(["--board", "https://clawtasks.com/api/bounties?status=open", "--paid-endpoint", "https://clawtasks.com/api/paid", "--attempt-cost-usd", "0", "--max-attempt-usd", "0.25", "--my-networks", "base", "--allow-unscored-payee"]);
  assert.deepEqual(b, { boardUrl: "https://clawtasks.com/api/bounties?status=open", paidEndpoint: "https://clawtasks.com/api/paid", attemptCostUsd: 0, maxAttemptUsd: 0.25, assumedWinProb: null, myNetworks: ["base"], allowUnscored: true });
  assert.throws(() => parseArgs(["--board", BOARD_URL, "--allow-unscored-payee", "yes"]), /unexpected argument/);
  assert.throws(() => parseArgs(["--board", BOARD_URL, "--max-attempt", "0.5"]), /unknown flag --max-attempt/, "a misspelled flag is refused, never silently ignored");
  assert.throws(() => parseArgs(["--board", BOARD_URL, "--board", BOARD_URL]), /repeated flag --board/);
  assert.throws(() => parseArgs([]), /--board/);
  assert.throws(() => parseArgs(["--board", "https://example.com/board"]), /--paid-endpoint/);
  assert.throws(() => parseArgs(["--board", "http://deskcrew.io/api/arena/contests"]), /https/);
  assert.throws(() => parseArgs(["--board", BOARD_URL, "--assumed-win-prob", "1.5"]), /assumed-win-prob/);
  assert.throws(() => parseArgs(["--board", BOARD_URL, "--attempt-cost-usd", "-1"]), /attempt-cost-usd/);
});

test("run: every network read carries a timeout so a dead board cannot hang the preflight", async () => {
  const inits: Array<RequestInit | undefined> = [];
  const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => { inits.push(init); return fakeFetch()(url as string, init); }) as unknown as typeof fetch;
  await runBountyPreflight(parseArgs(["--board", BOARD_URL, "--assumed-win-prob", "0.2"]), { fetch: fetchImpl, evaluate: allowGate, now: () => "2026-09-10T00:00:00.000Z" });
  assert.equal(inits.length, 2, "board GET + unpaid 402 GET");
  for (const init of inits) assert.ok(init?.signal instanceof AbortSignal, "each GET is bounded by an AbortSignal");
});

test("run: reads the board, reads the 402 payTo header-first, gates it, and decides each open row", async () => {
  const seen: Array<{ url: string; payTo?: string; network?: string }> = [];
  const evaluate: EvaluateFn = async (url, req, opts) => {
    seen.push({ url, payTo: req.payTo, network: req.network });
    assert.equal(opts.gateOnCanSpend, false);
    assert.equal(opts.refuseWashFlagged, true);
    assert.equal(opts.failOpen, false);
    return allowGate(url, req, opts);
  };
  const { report, exitCode } = await runBountyPreflight(parseArgs(["--board", BOARD_URL, "--assumed-win-prob", "0.2", "--attempt-cost-usd", "0.02"]), { fetch: fakeFetch(), evaluate, now: () => "2026-09-10T00:00:00.000Z" });
  assert.equal(exitCode, 0);
  assert.deepEqual(seen, [{ url: PING, payTo: PAY_TO, network: "eip155:8453" }], "the v2 header challenge wins over the v1 body");
  assert.equal(report.schema, "twzrd.bounty_preflight.v1");
  assert.equal(report.usdc_spent, 0);
  assert.equal(report.signer_invocation_count, 0);
  assert.equal(report.closes_external_adoption_metric, false);
  assert.deepEqual(report.gate, { decision: "warn", approved: true, reason: "thin history", pay_to: PAY_TO, network: "base", price_usdc: 0.02, reputation_scored: true, policy_action: "allow" });
  assert.equal(report.board.economics.decided_count, 372);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].proceed, true);
  assert.equal(report.rows[0].at_risk_usd, 0.08);
  assert.equal(report.proceed, true);
});

test("run: a gate block refuses with exit 1 and names the reasons", async () => {
  const { report, exitCode } = await runBountyPreflight(parseArgs(["--board", BOARD_URL, "--assumed-win-prob", "0.2"]), { fetch: fakeFetch(), evaluate: blockGate, now: () => "2026-09-10T00:00:00.000Z" });
  assert.equal(exitCode, 1);
  assert.equal(report.proceed, false);
  assert.deepEqual(report.refuse_reasons, ["gate_block", "gate_wash_flagged"]);
});

test("run: no declared win probability is a refusal even when everything else clears", async () => {
  const { report, exitCode } = await runBountyPreflight(parseArgs(["--board", BOARD_URL]), { fetch: fakeFetch(), evaluate: allowGate, now: () => "2026-09-10T00:00:00.000Z" });
  assert.equal(exitCode, 1);
  assert.deepEqual(report.refuse_reasons, ["assumed_win_prob_missing"]);
});

test("run: a paid endpoint that does not answer 402 is gated closed, never treated as free", async () => {
  let evaluated = 0;
  const fetchImpl = fakeFetch({ [PING]: () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) });
  const { report, exitCode } = await runBountyPreflight(parseArgs(["--board", BOARD_URL, "--assumed-win-prob", "0.2"]), { fetch: fetchImpl, evaluate: async (...a) => (evaluated++, allowGate(...a)), now: () => "2026-09-10T00:00:00.000Z" });
  assert.equal(evaluated, 0);
  assert.equal(exitCode, 1);
  assert.deepEqual(report.gate, { decision: "unknown", approved: false, reason: "paid_endpoint_not_402", pay_to: null, network: null, price_usdc: null, reputation_scored: false, policy_action: null });
  assert.deepEqual(report.refuse_reasons, ["gate_block", "gate_unscored"]);
});

test("run: a Base payTo the gate cannot score is refused as gate_unscored until the operator opts in", async () => {
  const refused = await runBountyPreflight(parseArgs(["--board", BOARD_URL, "--assumed-win-prob", "0.2"]), { fetch: fakeFetch(), evaluate: unscoredGate, now: () => "2026-09-10T00:00:00.000Z" });
  assert.equal(refused.exitCode, 1);
  assert.deepEqual(refused.report.refuse_reasons, ["gate_unscored"]);
  assert.deepEqual(refused.report.gate, { decision: "unknown", approved: true, reason: "unsupported_network_observe", pay_to: PAY_TO, network: "base", price_usdc: 0.02, reputation_scored: false, policy_action: "allow" });
  const optedIn = await runBountyPreflight(parseArgs(["--board", BOARD_URL, "--assumed-win-prob", "0.2", "--allow-unscored-payee"]), { fetch: fakeFetch(), evaluate: unscoredGate, now: () => "2026-09-10T00:00:00.000Z" });
  assert.equal(optedIn.exitCode, 0);
  assert.equal(optedIn.report.rows[0].proceed, true);
});

test("run: an unreadable board is an error, not a silent proceed", async () => {
  const fetchImpl = fakeFetch({ [BOARD_URL]: () => new Response("<html>", { status: 200 }) });
  await assert.rejects(() => runBountyPreflight(parseArgs(["--board", BOARD_URL, "--assumed-win-prob", "0.2"]), { fetch: fetchImpl, evaluate: allowGate }), /board/);
  const down = fakeFetch({ [BOARD_URL]: () => new Response("", { status: 503 }) });
  await assert.rejects(() => runBountyPreflight(parseArgs(["--board", BOARD_URL, "--assumed-win-prob", "0.2"]), { fetch: down, evaluate: allowGate }), /503/);
});

test("run: the live empty board reports no_open_rows with the gate verdict attached", async () => {
  const fetchImpl = fakeFetch({ [BOARD_URL]: () => new Response(JSON.stringify({ ...DESKCREW, bounties: [] }), { status: 200, headers: { "content-type": "application/json" } }) });
  const { report, exitCode } = await runBountyPreflight(parseArgs(["--board", BOARD_URL, "--assumed-win-prob", "0.2"]), { fetch: fetchImpl, evaluate: allowGate, now: () => "2026-09-10T00:00:00.000Z" });
  assert.equal(exitCode, 1);
  assert.deepEqual(report.refuse_reasons, ["no_open_rows"]);
  assert.equal(report.gate?.approved, true);
});
