/**
 * Worker-side bounty preflight (pure).
 *
 * A bounty-hunting agent pays a small attempt fee (or stakes collateral) before it
 * knows whether a human will accept its work. Before that money moves, this module
 * answers four questions from public board data plus a TWZRD verdict on the board's
 * payTo:
 *
 *   1. Did TWZRD refuse the payee (block / wash)?
 *   2. Can this wallet receive on the row's payout rail?
 *   3. Is the money at risk (attempt fee + entry fee + stake) under the ceiling?
 *   4. Does the OPERATOR'S declared win probability clear break-even?
 *
 * It reports the board's approval rate, contest size, and two EV estimates for
 * context, but it never turns a board-wide approval rate into the caller's own
 * paid-win probability: that number has to be declared. Nothing here signs or spends.
 */

export const BOUNTY_PREFLIGHT_SCHEMA = "twzrd.bounty_preflight.v1";

export type BoardSource = "deskcrew" | "clawtasks";

export type BoardRow = {
  id: string;
  title: string | null;
  bounty_usd: number | null;
  /** Fraction of the bounty the worker receives on acceptance (0..1). */
  agent_share: number | null;
  entrants: number | null;
  payout_network: string | null;
  approval_rate_pct: number | null;
  /** Fee the board charges to enter this row, on top of the caller's attempt cost. */
  entry_fee_usd: number;
  /** Collateral at risk on final rejection (ClawTasks: 10% of the bounty). */
  stake_usd: number;
  source: BoardSource;
};

export type BoardEconomics = {
  decided_count?: number | null;
  open_bounties?: number | null;
  payouts_sent?: number | null;
  payouts_usd?: number | null;
  unique_wallets?: number | null;
  median_decision_hours?: number | null;
};

export type BoardDescriptor = {
  source: BoardSource;
  agent_share: number | null;
  approval_rate_pct: number | null;
  economics: BoardEconomics;
  open_rows: BoardRow[];
};

/** What the TWZRD gate said about the board's payTo (from evaluate_x402_resource).
 *  `reputationScored: false` means the rail is outside the behavioral corpus
 *  (today: anything but Solana) and `approved` is a policy pass-through with only
 *  the wash axis checked. A policy allow is never a trust allow. */
export type GateVerdict = {
  decision: "allow" | "warn" | "block" | "unknown";
  approved: boolean;
  reason: string;
  payTo?: string | null;
  network?: string | null;
  priceUsdc?: number | null;
  washFlagged?: boolean | null;
  reputationScored?: boolean | null;
  policyAction?: "allow" | "block" | null;
};

export type DecideArgs = {
  attemptCostUsd: number;
  maxAttemptUsd: number | null;
  assumedWinProb: number | null;
  myNetworks: string[];
  /** Proceed on a payee the gate could not score (wash still refuses). Default false. */
  allowUnscored: boolean;
};

export type DecideInput = DecideArgs & { row: BoardRow; gate: GateVerdict | null };

export type Decision = {
  proceed: boolean;
  reasons: string[];
  at_risk_usd: number;
  break_even_win_prob: number | null;
  ev_naive_usd: number | null;
  ev_contested_usd: number | null;
};

const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : v == null ? null : String(v);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function normalizeNetwork(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.trim().toLowerCase();
  if (!n) return null;
  if (n.includes("8453") || n.startsWith("base")) return "base";
  if (n.includes("solana")) return "solana";
  return n;
}

/** Money at risk over the worker's share of the bounty. 0 when nothing is at risk. */
export function breakEvenWinProb(atRiskUsd: number, agentShare: number | null, bountyUsd: number | null): number | null {
  const denom = (agentShare ?? 0) * (bountyUsd ?? 0);
  if (!(denom > 0)) return null;
  if (!(atRiskUsd > 0)) return 0;
  return atRiskUsd / denom;
}

function pick(r: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
  return undefined;
}

/**
 * GET https://deskcrew.io/api/arena/contests. Board-level economics are read from the
 * live shape (2026-09-10). The board carried no open rows that day, so row keys follow
 * the descriptor's own prose (entrants, payoutNetwork, entry fee) and its bountyCurve
 * (bountyUsd); unknown rows degrade to nulls rather than invented figures.
 */
export function parseDeskcrewDescriptor(json: unknown): BoardDescriptor {
  if (!isRecord(json) || !isRecord(json.economics)) throw new Error("deskcrew descriptor: missing economics block");
  const eco = json.economics;
  const payouts = isRecord(eco.payouts) ? eco.payouts : {};
  const latency = isRecord(eco.decisionLatency) ? eco.decisionLatency : {};
  const agentShare = num(json.agentShare) ?? num(eco.agentShare);
  const approval = num(eco.approvalRatePct);
  const rows = [
    ...(Array.isArray(json.bounties) ? json.bounties : []),
    ...(Array.isArray(json.contests) ? json.contests : []),
  ].filter(isRecord);
  const open_rows: BoardRow[] = rows.map((r, i) => {
    const board = isRecord(r.board) ? r.board : {};
    return {
      id: str(pick(r, "id", "ticketId", "contestId", "rowId")) ?? `row-${i}`,
      title: str(pick(r, "title", "subject")),
      bounty_usd: num(pick(r, "bountyUsd", "bounty_usd", "rewardUsd", "reward", "bounty")),
      agent_share: num(r.agentShare) ?? agentShare,
      entrants: num(pick(r, "entrants", "entrantCount")),
      payout_network: normalizeNetwork(pick(r, "payoutNetwork", "payout_network", "network")),
      approval_rate_pct: num(pick(r, "approvalRatePct")) ?? num(board.approvalRatePct) ?? approval,
      entry_fee_usd: num(pick(r, "entryFeeUsd", "entryFee", "feeUsd", "fee")) ?? 0,
      stake_usd: 0,
      source: "deskcrew",
    };
  });
  return {
    source: "deskcrew",
    agent_share: agentShare,
    approval_rate_pct: approval,
    economics: {
      decided_count: num(eco.decidedCount),
      open_bounties: num(eco.openBounties),
      payouts_sent: num(payouts.sentCount),
      payouts_usd: num(payouts.sentUsd),
      unique_wallets: num(payouts.uniqueWallets),
      median_decision_hours: num(latency.medianHours),
    },
    open_rows,
  };
}

const CLAWTASKS_SHARE = 0.95;
const CLAWTASKS_STAKE = 0.1;

/** GET https://clawtasks.com/api/bounties?status=open: Base escrow, worker keeps 95%,
 *  10% of the bounty is staked and lost on final rejection. */
export function parseClawtasksOpen(json: unknown): BoardDescriptor {
  const list = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json.bounties)
      ? json.bounties
      : isRecord(json) && Array.isArray(json.data)
        ? json.data
        : [];
  const open_rows: BoardRow[] = list.filter(isRecord).map((r, i) => {
    const bounty = num(pick(r, "amount", "bounty_amount", "amount_usdc", "reward"));
    return {
      id: str(pick(r, "id", "bounty_id")) ?? `row-${i}`,
      title: str(pick(r, "title", "name")),
      bounty_usd: bounty,
      agent_share: CLAWTASKS_SHARE,
      entrants: null,
      payout_network: "base",
      approval_rate_pct: null,
      entry_fee_usd: 0,
      stake_usd: bounty === null ? 0 : round6(bounty * CLAWTASKS_STAKE),
      source: "clawtasks",
    };
  });
  return { source: "clawtasks", agent_share: CLAWTASKS_SHARE, approval_rate_pct: null, economics: {}, open_rows };
}

export function parseBoardDescriptor(json: unknown): BoardDescriptor {
  if (isRecord(json) && isRecord(json.economics)) return parseDeskcrewDescriptor(json);
  if (Array.isArray(json) || (isRecord(json) && (Array.isArray(json.bounties) || Array.isArray(json.data)))) return parseClawtasksOpen(json);
  throw new Error("unrecognized board descriptor: expected a DeskCrew arena descriptor or a ClawTasks bounty list");
}

export function decideBounty({ row, attemptCostUsd, maxAttemptUsd, assumedWinProb, myNetworks, allowUnscored, gate }: DecideInput): Decision {
  const reasons: string[] = [];
  if (!gate) reasons.push("gate_not_evaluated");
  else {
    if (!gate.approved || gate.decision === "block") reasons.push("gate_block");
    if (gate.washFlagged === true || /wash/i.test(gate.reason ?? "")) reasons.push("gate_wash_flagged");
    if (gate.reputationScored === false && !allowUnscored) reasons.push("gate_unscored");
  }
  if (row.payout_network === null) reasons.push("payout_network_unknown");
  else if (!myNetworks.map(normalizeNetwork).includes(row.payout_network)) reasons.push("payout_network_unsupported");
  const at_risk_usd = round6(attemptCostUsd + row.entry_fee_usd + row.stake_usd);
  if (maxAttemptUsd !== null && maxAttemptUsd !== undefined && at_risk_usd > maxAttemptUsd) reasons.push("attempt_cost_over_max");
  const break_even_win_prob = breakEvenWinProb(at_risk_usd, row.agent_share, row.bounty_usd);
  if (break_even_win_prob === null) reasons.push("bounty_unpriced");
  if (assumedWinProb === null || assumedWinProb === undefined) reasons.push("assumed_win_prob_missing");
  else if (break_even_win_prob !== null && assumedWinProb < break_even_win_prob) reasons.push("below_break_even");
  const share = (row.agent_share ?? 0) * (row.bounty_usd ?? 0);
  const p = row.approval_rate_pct === null ? null : row.approval_rate_pct / 100;
  const ev_naive_usd = p === null ? null : round6(p * share - at_risk_usd);
  const ev_contested_usd = p === null ? null : round6((p / Math.max(1, row.entrants ?? 1)) * share - at_risk_usd);
  return { proceed: reasons.length === 0, reasons, at_risk_usd, break_even_win_prob, ev_naive_usd, ev_contested_usd };
}

export type PreflightReport = {
  schema: typeof BOUNTY_PREFLIGHT_SCHEMA;
  lineage: "self_serve_handoff_command";
  closes_external_adoption_metric: false;
  note: string;
  checked_at: string;
  board_url: string;
  paid_endpoint: string;
  usdc_spent: 0;
  signer_invocation_count: 0;
  args: DecideArgs;
  board: { source: BoardSource; agent_share: number | null; approval_rate_pct: number | null; economics: BoardEconomics; open_rows: number };
  gate: {
    decision: GateVerdict["decision"]; approved: boolean; reason: string; pay_to: string | null; network: string | null; price_usdc: number | null;
    reputation_scored: boolean; policy_action: "allow" | "block" | null;
  } | null;
  rows: Array<BoardRow & Decision>;
  proceed: boolean;
  refuse_reasons: string[];
};

export function buildPreflightReport({ board, boardUrl, paidEndpoint, gate, args, checkedAt }: {
  board: BoardDescriptor; boardUrl: string; paidEndpoint: string; gate: GateVerdict | null; args: DecideArgs; checkedAt: string;
}): PreflightReport {
  const rows = board.open_rows.map((row) => ({ ...row, ...decideBounty({ row, gate, ...args }) }));
  const refuse_reasons: string[] = [];
  if (!rows.length) refuse_reasons.push("no_open_rows");
  for (const r of rows) for (const reason of r.reasons) if (!refuse_reasons.includes(reason)) refuse_reasons.push(reason);
  return {
    schema: BOUNTY_PREFLIGHT_SCHEMA,
    lineage: "self_serve_handoff_command",
    closes_external_adoption_metric: false,
    note: "Worker preflight transcript: public board data plus a free TWZRD verdict on the board payTo. No signer, no USDC. Board approval rates are context, never the caller's win probability. proceed/exit 0 means at least one open row is eligible — pay only rows with proceed:true.",
    checked_at: checkedAt,
    board_url: boardUrl,
    paid_endpoint: paidEndpoint,
    usdc_spent: 0,
    signer_invocation_count: 0,
    args,
    board: { source: board.source, agent_share: board.agent_share, approval_rate_pct: board.approval_rate_pct, economics: board.economics, open_rows: board.open_rows.length },
    gate: gate
      ? {
          decision: gate.decision, approved: gate.approved, reason: gate.reason, pay_to: gate.payTo ?? null, network: normalizeNetwork(gate.network), price_usdc: gate.priceUsdc ?? null,
          reputation_scored: gate.reputationScored === true, policy_action: gate.policyAction ?? null,
        }
      : null,
    rows,
    proceed: rows.some((r) => r.proceed),
    refuse_reasons,
  };
}
