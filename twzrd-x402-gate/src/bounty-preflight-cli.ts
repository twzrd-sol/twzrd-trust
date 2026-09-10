/**
 * Orchestration behind bin/twzrd-bounty-preflight.js, with fetch and the gate
 * injected so it can be tested without a network. Read-only: two GETs (the board,
 * the paid endpoint unpaid to read its 402) plus the free TWZRD preflight. Nothing
 * is signed, nothing is spent.
 */
import { evaluate_x402_resource, type EvaluateX402Options, type EvaluateX402Result } from "./evaluate.js";
import { paymentRequiredFromResponse, payToFromRequirements, pickRequirements, priceUsdcFromAmountMicro } from "./payto.js";
import { buildPreflightReport, parseBoardDescriptor, type DecideArgs, type GateVerdict, type PreflightReport } from "./bounty-preflight.js";
import type { X402PaymentRequirements } from "./types.js";

export type PreflightArgs = DecideArgs & { boardUrl: string; paidEndpoint: string };

export type EvaluateFn = (
  url: string,
  req: X402PaymentRequirements,
  opts: EvaluateX402Options,
) => Promise<Pick<EvaluateX402Result, "decision" | "approved" | "reason"> & Partial<EvaluateX402Result>>;

/** Boards whose paid door is known, so `--paid-endpoint` can be omitted. */
const DEFAULT_PAID_ENDPOINTS: Record<string, string> = {
  "deskcrew.io": "https://deskcrew.io/api/x402/paid/ping",
};
const DEFAULT_ATTEMPT_COST_USD = 0.08; // DeskCrew: $0.02 ticket context + $0.06 submission
const DEFAULT_NETWORKS = ["solana", "base"];

export const USAGE = `usage: twzrd-bounty-preflight --board <https url> [--paid-endpoint <https url>]
         [--attempt-cost-usd 0.08] [--max-attempt-usd <usd>] [--assumed-win-prob <0..1>]
         [--my-networks solana,base]

  --board            board descriptor: DeskCrew arena JSON or a ClawTasks open-bounty list
  --paid-endpoint    the board's x402 door; its unpaid 402 names the payTo the gate scores
                     (defaults to the paid ping for deskcrew.io)
  --attempt-cost-usd money you spend per attempt before any entry fee or stake (default 0.08)
  --max-attempt-usd  ceiling on money at risk per attempt (fee + entry fee + stake)
  --assumed-win-prob YOUR declared paid-win probability; the board's approval rate is
                     never substituted for it. Without it the tool refuses.
  --my-networks      rails your wallet can receive on (default solana,base)
  --allow-unscored-payee
                     proceed when the gate cannot score the payee's rail (today: any
                     non-Solana payTo). Wash still refuses. Default: refuse (gate_unscored).`;

const BOOLEAN_FLAGS = new Set(["--allow-unscored-payee"]);
const VALUE_FLAGS = new Set(["--board", "--paid-endpoint", "--attempt-cost-usd", "--max-attempt-usd", "--assumed-win-prob", "--my-networks"]);
/** Bound on each read (board descriptor, unpaid 402): a dead board must not hang a preflight. */
const FETCH_TIMEOUT_MS = 15_000;

function httpsUrl(flag: string, raw: string | undefined): string {
  if (!raw) throw new Error(`${flag} is required`);
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`${flag} must be an https URL`); }
  if (u.protocol !== "https:") throw new Error(`${flag} must be an https URL`);
  return u.toString();
}

function nonNegative(flag: string, raw: string | undefined, fallback: number | null): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative number`);
  return n;
}

export function parseArgs(argv: string[]): PreflightArgs {
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    if (BOOLEAN_FLAGS.has(a)) { switches.add(a); continue; }
    if (!VALUE_FLAGS.has(a)) throw new Error(`unknown flag ${a}`);
    if (flags.has(a)) throw new Error(`repeated flag ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    flags.set(a, v);
    i += 1;
  }
  const boardUrl = httpsUrl("--board", flags.get("--board"));
  const host = new URL(boardUrl).hostname.replace(/^www\./, "");
  const paidEndpoint = flags.has("--paid-endpoint")
    ? httpsUrl("--paid-endpoint", flags.get("--paid-endpoint"))
    : DEFAULT_PAID_ENDPOINTS[host];
  if (!paidEndpoint) throw new Error("--paid-endpoint is required for this board (no known paid door)");
  const attemptCostUsd = nonNegative("--attempt-cost-usd", flags.get("--attempt-cost-usd"), DEFAULT_ATTEMPT_COST_USD) as number;
  const maxAttemptUsd = nonNegative("--max-attempt-usd", flags.get("--max-attempt-usd"), null);
  let assumedWinProb: number | null = null;
  if (flags.has("--assumed-win-prob")) {
    const p = Number(flags.get("--assumed-win-prob"));
    if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error("--assumed-win-prob must be between 0 and 1");
    assumedWinProb = p;
  }
  const myNetworks = (flags.get("--my-networks") ?? DEFAULT_NETWORKS.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!myNetworks.length) throw new Error("--my-networks must name at least one rail");
  return { boardUrl, paidEndpoint, attemptCostUsd, maxAttemptUsd, assumedWinProb, myNetworks, allowUnscored: switches.has("--allow-unscored-payee") };
}

const UNGATED = (reason: string): GateVerdict => ({ decision: "unknown", approved: false, reason, payTo: null, network: null, priceUsdc: null, reputationScored: false, policyAction: null });

export async function runBountyPreflight(
  args: PreflightArgs,
  { fetch: doFetch = globalThis.fetch, evaluate = evaluate_x402_resource as EvaluateFn, now = () => new Date().toISOString() }:
    { fetch?: typeof fetch; evaluate?: EvaluateFn; now?: () => string } = {},
): Promise<{ report: PreflightReport; exitCode: 0 | 1 }> {
  const bounded = () => ({ headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const boardRes = await doFetch(args.boardUrl, bounded());
  if (!boardRes.ok) throw new Error(`board GET ${boardRes.status}`);
  let boardJson: unknown;
  try { boardJson = JSON.parse(await boardRes.text()); } catch { throw new Error("board descriptor is not JSON"); }
  const board = parseBoardDescriptor(boardJson);

  // The unpaid 402 is the only honest source of the payTo the worker is about to pay.
  let gate: GateVerdict;
  const paidRes = await doFetch(args.paidEndpoint, bounded());
  if (paidRes.status !== 402) gate = UNGATED("paid_endpoint_not_402");
  else {
    const challenge = await paymentRequiredFromResponse(paidRes);
    const req = pickRequirements(challenge?.accepts);
    const { payTo, amountMicro } = payToFromRequirements(req);
    if (!payTo) gate = UNGATED("paid_endpoint_no_payto");
    else {
      const result = await evaluate(args.paidEndpoint, req, { gateOnCanSpend: false, refuseWashFlagged: true, failOpen: false, fetch: doFetch });
      gate = {
        decision: result.decision,
        approved: result.approved,
        reason: result.reason,
        payTo,
        network: req.network ?? null,
        priceUsdc: priceUsdcFromAmountMicro(amountMicro) ?? null,
        reputationScored: result.reputationScored ?? null,
        policyAction: result.policyAction ?? null,
      };
    }
  }

  const { boardUrl, paidEndpoint, ...decideArgs } = args;
  const report = buildPreflightReport({ board, boardUrl, paidEndpoint, gate, args: decideArgs, checkedAt: now() });
  return { report, exitCode: report.proceed ? 0 : 1 };
}
