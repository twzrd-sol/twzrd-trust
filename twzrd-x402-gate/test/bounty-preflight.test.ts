/**
 * Worker-side bounty preflight: pure math + parsers behind bin/twzrd-bounty-preflight.js.
 * Run: npx tsx --test test/bounty-preflight.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BOUNTY_PREFLIGHT_SCHEMA,
  breakEvenWinProb,
  buildPreflightReport,
  decideBounty,
  normalizeNetwork,
  parseBoardDescriptor,
  parseClawtasksOpen,
  parseDeskcrewDescriptor,
  type BoardRow,
  type GateVerdict,
} from "../src/bounty-preflight.js";

// Live DeskCrew descriptor, GET https://deskcrew.io/api/arena/contests on 2026-09-10
// (read-only). The board carried zero open rows that day; row fixtures below use the
// key names the descriptor's own prose and bountyCurve publish.
const DESKCREW = {
  enabled: false, bountiesEnabled: true, bounties: [], contests: [], count: 0, agentShare: 0.85,
  economics: {
    openBounties: 0, openBountyUsd: 0, avgBountyUsd: null, approvalRatePct: 21, approvedAsIsRatePct: 20, approvedWithEdits: 3, decidedCount: 372,
    decisionLatency: { medianHours: 23.85, p90Hours: 57.88, decidedCount30d: 331, undecidedNow: 0, oldestUndecidedHours: null },
    payouts: { sentCount: 67, sentUsd: 56.14, uniqueWallets: 22, latestTxHash: "ILHJ75DKUT27JE3JKZPAGFP7X5JXZXOIJL5ZPKTHB7P5KCWNIP6A", avgHoursToPayout: 0.04 },
    agentShare: 0.85,
    bountyCurve: [
      { bountyUsd: 0.25, rowsDecided: 2, contested: 2, awardedPct: 100, avgFinalEntrants: null, approvedAsIsPct: 100 },
      { bountyUsd: 1, rowsDecided: 71, contested: 63, awardedPct: 80, avgFinalEntrants: 4.8, approvedAsIsPct: 100 },
    ],
  },
  howToEnter: "Draft a reply on the ticket through the agent door...",
  humanPage: "https://deskcrew.io/arena", agentDocs: "https://deskcrew.io/agents", runYourOwn: "https://deskcrew.io/bounties",
};
const DESKCREW_ROW = { id: "t-1001", title: "Refund not received", bountyUsd: 1, entrants: 5, payoutNetwork: "base", entryFeeUsd: 0.06 };
const GATE_OK: GateVerdict = { decision: "warn", approved: true, reason: "thin history", payTo: "0xB075aA8206D6De88EDEeD0eE4015a1a33D3659D8", network: "eip155:8453", priceUsdc: 0.02, reputationScored: true, policyAction: "allow" };
const GATE_BLOCK: GateVerdict = { ...GATE_OK, decision: "block", approved: false, reason: "twzrd_wash_flagged refuse", policyAction: "block" };
// What the buyer gate actually returns for a Base payTo today: reputation is Solana-only,
// so the "allow" is the observe-mode policy pass-through with only the wash axis checked.
const GATE_UNSCORED: GateVerdict = { ...GATE_OK, decision: "unknown", approved: true, reason: "unsupported_network_observe", reputationScored: false, policyAction: "allow" };

test("normalizeNetwork folds CAIP-2 and marketing names onto solana | base", () => {
  assert.equal(normalizeNetwork("eip155:8453"), "base");
  assert.equal(normalizeNetwork("base"), "base");
  assert.equal(normalizeNetwork("Base-Mainnet"), "base");
  assert.equal(normalizeNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), "solana");
  assert.equal(normalizeNetwork("solana"), "solana");
  assert.equal(normalizeNetwork("algorand"), "algorand");
  assert.equal(normalizeNetwork(null), null);
  assert.equal(normalizeNetwork(""), null);
});

test("breakEvenWinProb: at-risk cost over the worker's share of the bounty", () => {
  assert.equal(Number(breakEvenWinProb(0.08, 0.85, 0.25)?.toFixed(4)), 0.3765, "$0.25 bounty at $0.08 needs a 37.6% paid-win probability");
  assert.equal(Number(breakEvenWinProb(0.08, 0.85, 1)?.toFixed(4)), 0.0941, "$1 bounty at $0.08 needs 9.4%");
  assert.equal(breakEvenWinProb(0.08, 0.85, 0), null, "an unpriced bounty has no break-even");
  assert.equal(breakEvenWinProb(0, 0.85, 1), 0, "free attempts break even at any win rate");
  assert.equal(breakEvenWinProb(0.08, 0, 1), null);
});

test("parseDeskcrewDescriptor: board economics and rows in the descriptor's vocabulary", () => {
  const board = parseDeskcrewDescriptor({ ...DESKCREW, bounties: [DESKCREW_ROW], contests: [{ ...DESKCREW_ROW, id: "c-7", bountyUsd: 0.25, entrants: 2, payoutNetwork: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }] });
  assert.equal(board.source, "deskcrew");
  assert.equal(board.agent_share, 0.85);
  assert.equal(board.approval_rate_pct, 21);
  assert.deepEqual(board.economics, { decided_count: 372, open_bounties: 0, payouts_sent: 67, payouts_usd: 56.14, unique_wallets: 22, median_decision_hours: 23.85 });
  assert.equal(board.open_rows.length, 2);
  const [row, contest] = board.open_rows;
  assert.deepEqual(row, { id: "t-1001", title: "Refund not received", bounty_usd: 1, agent_share: 0.85, entrants: 5, payout_network: "base", approval_rate_pct: 21, entry_fee_usd: 0.06, stake_usd: 0, source: "deskcrew" });
  assert.equal(contest.payout_network, "solana");
  assert.equal(contest.bounty_usd, 0.25);
});

test("parseDeskcrewDescriptor: the live empty board parses to zero rows, not an error", () => {
  const board = parseDeskcrewDescriptor(DESKCREW);
  assert.deepEqual(board.open_rows, []);
  assert.equal(board.economics.decided_count, 372);
  assert.throws(() => parseDeskcrewDescriptor(null), /descriptor/);
  assert.throws(() => parseDeskcrewDescriptor({ enabled: true }), /descriptor/);
});

test("parseClawtasksOpen: Base-only escrow board, 95% to the worker, 10% stake at risk", () => {
  const board = parseClawtasksOpen({ bounties: [{ id: "b1", title: "Scrape a sitemap", amount: 2, status: "open", mode: "instant" }, { id: "b2", title: "x", amount: "0.5", status: "open" }] });
  assert.equal(board.source, "clawtasks");
  assert.equal(board.agent_share, 0.95);
  assert.equal(board.approval_rate_pct, null, "ClawTasks publishes no board-level approval history");
  assert.deepEqual(board.open_rows[0], { id: "b1", title: "Scrape a sitemap", bounty_usd: 2, agent_share: 0.95, entrants: null, payout_network: "base", approval_rate_pct: null, entry_fee_usd: 0, stake_usd: 0.2, source: "clawtasks" });
  assert.equal(board.open_rows[1].stake_usd, 0.05);
  assert.deepEqual(parseClawtasksOpen([]).open_rows, []);
});

test("parseBoardDescriptor dispatches on shape", () => {
  assert.equal(parseBoardDescriptor(DESKCREW).source, "deskcrew");
  assert.equal(parseBoardDescriptor({ bounties: [{ id: "b1", amount: 1 }] }).source, "clawtasks");
  assert.throws(() => parseBoardDescriptor({ hello: 1 }), /unrecognized/);
});

const row = (over: Partial<BoardRow> = {}): BoardRow => ({ id: "t-1001", title: "Refund", bounty_usd: 1, agent_share: 0.85, entrants: 5, payout_network: "base", approval_rate_pct: 21, entry_fee_usd: 0.06, stake_usd: 0, source: "deskcrew", ...over });
const base = { row: row(), attemptCostUsd: 0.02, maxAttemptUsd: 0.5, assumedWinProb: 0.2, myNetworks: ["solana", "base"], allowUnscored: false, gate: GATE_OK };

test("decideBounty fails closed on a payee the gate could not score, unless the operator opts in", () => {
  assert.deepEqual(decideBounty({ ...base, gate: GATE_UNSCORED }).reasons, ["gate_unscored"], "a policy allow is not a trust allow");
  assert.deepEqual(decideBounty({ ...base, gate: GATE_UNSCORED, allowUnscored: true }).reasons, []);
  assert.deepEqual(decideBounty({ ...base, gate: { ...GATE_UNSCORED, approved: false, decision: "block", reason: "twzrd_wash_flagged" }, allowUnscored: true }).reasons, ["gate_block", "gate_wash_flagged"], "wash on an unscored rail still refuses");
});

test("decideBounty proceeds when the gate allows, the rail matches, the cost fits, and the declared win probability clears break-even", () => {
  const d = decideBounty(base);
  assert.equal(d.proceed, true);
  assert.deepEqual(d.reasons, []);
  assert.equal(d.at_risk_usd, 0.08, "operator attempt cost + the row's entry fee + stake");
  assert.equal(Number(d.break_even_win_prob?.toFixed(4)), 0.0941);
  assert.equal(Number(d.ev_naive_usd?.toFixed(4)), 0.0985, "21% x 0.85 x $1 - $0.08");
  assert.equal(Number(d.ev_contested_usd?.toFixed(4)), -0.0443, "(21% / 5 entrants) x 0.85 x $1 - $0.08");
});

test("decideBounty never turns the board approval rate into the caller's win probability", () => {
  const d = decideBounty({ ...base, assumedWinProb: null });
  assert.equal(d.proceed, false);
  assert.deepEqual(d.reasons, ["assumed_win_prob_missing"]);
  assert.equal(Number(d.ev_naive_usd?.toFixed(4)), 0.0985, "reported for context only");
});

test("decideBounty refuses below break-even", () => {
  const d = decideBounty({ ...base, row: row({ bounty_usd: 0.25 }), assumedWinProb: 0.2 });
  assert.deepEqual(d.reasons, ["below_break_even"]);
  assert.equal(Number(d.break_even_win_prob?.toFixed(4)), 0.3765);
});

test("decideBounty refuses on gate block, wash, or an unevaluated payee", () => {
  assert.deepEqual(decideBounty({ ...base, gate: GATE_BLOCK }).reasons, ["gate_block", "gate_wash_flagged"]);
  assert.deepEqual(decideBounty({ ...base, gate: { ...GATE_OK, approved: false, reason: "twzrd_preflight_unavailable" } }).reasons, ["gate_block"]);
  assert.deepEqual(decideBounty({ ...base, gate: null }).reasons, ["gate_not_evaluated"]);
});

test("decideBounty refuses a payout rail the worker cannot receive on, or an unknown rail", () => {
  assert.deepEqual(decideBounty({ ...base, myNetworks: ["solana"] }).reasons, ["payout_network_unsupported"]);
  assert.deepEqual(decideBounty({ ...base, row: row({ payout_network: "algorand" }) }).reasons, ["payout_network_unsupported"]);
  assert.deepEqual(decideBounty({ ...base, row: row({ payout_network: null }) }).reasons, ["payout_network_unknown"]);
});

test("decideBounty refuses when the money at risk exceeds the ceiling, counting fee and stake", () => {
  assert.deepEqual(decideBounty({ ...base, maxAttemptUsd: 0.05 }).reasons, ["attempt_cost_over_max"]);
  const staked = decideBounty({ ...base, row: row({ source: "clawtasks", entry_fee_usd: 0, stake_usd: 0.2, bounty_usd: 2, agent_share: 0.95, approval_rate_pct: null, entrants: null }), attemptCostUsd: 0, maxAttemptUsd: 0.1 });
  assert.equal(staked.at_risk_usd, 0.2);
  assert.deepEqual(staked.reasons, ["attempt_cost_over_max"]);
  assert.equal(staked.ev_naive_usd, null, "no approval history, no EV estimate");
});

test("decideBounty reports every reason, in a stable order", () => {
  const d = decideBounty({ ...base, gate: GATE_BLOCK, myNetworks: ["solana"], maxAttemptUsd: 0.01, assumedWinProb: 0.01 });
  assert.deepEqual(d.reasons, ["gate_block", "gate_wash_flagged", "payout_network_unsupported", "attempt_cost_over_max", "below_break_even"]);
});

test("buildPreflightReport is a zero-spend self-serve transcript, never an adoption metric", () => {
  const board = parseDeskcrewDescriptor({ ...DESKCREW, bounties: [DESKCREW_ROW] });
  const report = buildPreflightReport({
    board, boardUrl: "https://deskcrew.io/api/arena/contests", paidEndpoint: "https://deskcrew.io/api/x402/paid/ping", gate: GATE_OK,
    args: { attemptCostUsd: 0.02, maxAttemptUsd: 0.5, assumedWinProb: 0.2, myNetworks: ["solana", "base"], allowUnscored: false },
    checkedAt: "2026-09-10T00:00:00.000Z",
  });
  assert.equal(report.schema, BOUNTY_PREFLIGHT_SCHEMA);
  assert.equal(report.gate?.reputation_scored, true);
  assert.equal(report.gate?.policy_action, "allow");
  assert.equal(report.lineage, "self_serve_handoff_command");
  assert.equal(report.closes_external_adoption_metric, false);
  assert.equal(report.usdc_spent, 0);
  assert.equal(report.signer_invocation_count, 0);
  assert.equal(report.board.source, "deskcrew");
  assert.equal(report.gate?.pay_to, GATE_OK.payTo);
  assert.equal(report.gate?.network, "base");
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].proceed, true);
  assert.equal(report.proceed, true);
  assert.deepEqual(report.refuse_reasons, []);
  const empty = buildPreflightReport({ board: parseDeskcrewDescriptor(DESKCREW), boardUrl: "u", paidEndpoint: "p", gate: GATE_OK, args: { attemptCostUsd: 0.02, maxAttemptUsd: null, assumedWinProb: 0.2, myNetworks: ["base"], allowUnscored: false }, checkedAt: "2026-09-10T00:00:00.000Z" });
  assert.equal(empty.proceed, false);
  assert.deepEqual(empty.refuse_reasons, ["no_open_rows"]);
  const blocked = buildPreflightReport({ board, boardUrl: "u", paidEndpoint: "p", gate: GATE_BLOCK, args: { attemptCostUsd: 0.02, maxAttemptUsd: null, assumedWinProb: 0.2, myNetworks: ["base"], allowUnscored: false }, checkedAt: "2026-09-10T00:00:00.000Z" });
  assert.equal(blocked.proceed, false);
  assert.deepEqual(blocked.refuse_reasons, ["gate_block", "gate_wash_flagged"]);
});

test("buildPreflightReport: proceed means at least one eligible row, not every row", () => {
  const board = parseDeskcrewDescriptor({
    ...DESKCREW,
    bounties: [DESKCREW_ROW, { ...DESKCREW_ROW, id: "t-cheap", bountyUsd: 0.25, entrants: 2 }],
  });
  const report = buildPreflightReport({
    board, boardUrl: "u", paidEndpoint: "p", gate: GATE_OK,
    args: { attemptCostUsd: 0.02, maxAttemptUsd: 0.5, assumedWinProb: 0.2, myNetworks: ["solana", "base"], allowUnscored: false },
    checkedAt: "2026-09-10T00:00:00.000Z",
  });
  assert.equal(report.rows[0].proceed, true);
  assert.deepEqual(report.rows[1].reasons, ["below_break_even"]);
  assert.equal(report.proceed, true, "one eligible row is enough for proceed/exit 0");
  assert.deepEqual(report.refuse_reasons, ["below_break_even"]);
  assert.match(report.note, /at least one open row is eligible/);
});
