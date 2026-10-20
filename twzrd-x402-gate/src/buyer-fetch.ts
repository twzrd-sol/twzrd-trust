import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { resolveConfig } from "./config.js";
import { createFileDecisionLedger, type DecisionLedgerRow } from "./decision-ledger-file.js";
import { toMicroUsd } from "./intent.js";
import { isUsdcRequirement, resolveRequirementFields } from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";
import type { SpendLedger } from "./policy-runtime.js";
import { sharedFileSpendLedger } from "./spend-ledger-file.js";
import type { X402ClientLike } from "./x402-client-hook.js";

export type BuyerFetchOptions = {
  /** Dedicated official x402 client with schemes/signers already registered. */
  client: X402ClientLike;
  /** Required per-payment USDC ceiling, as an exact decimal string. */
  maxPricePerCall: string;
  /** Required payTo allowlist. Empty means refuse every payment. */
  allowedRecipients: readonly string[];
  /** Optional cumulative USDC ceiling over the preceding hour. */
  hourlyBudgetCap?: string;
  /** Defaults to .twzrd/decisions.jsonl. One process must own each file. */
  decisionFile?: string;
  /** Defaults to .twzrd/spend.jsonl. One process must own each file. */
  spendLedgerFile?: string;
  /** Shared budget scope within the spend ledger. Default: default. */
  budgetScope?: string;
  /** Raw HTTP transport, never an already-paying fetch. */
  fetch?: typeof fetch;
  /** Free intelligence transport; defaults to the raw transport. */
  preflightFetch?: typeof fetch;
  intelBase?: string;
  /** Timeout for each free intelligence call. Default: 2000ms. */
  intelTimeoutMs?: number;
};

export class BuyerFetchBlockedError extends Error {
  override name = "BuyerFetchBlockedError";
  constructor(public readonly reason: string, options?: ErrorOptions) {
    super(`[twzrd-buyer-fetch] ${reason}`, options);
  }
}

type Attempt = {
  resource: string;
  signal?: AbortSignal;
  challengeSeen: boolean;
  recorded: boolean;
  blocked?: BuyerFetchBlockedError;
  approvedForSigning?: boolean;
  input: { resource: string; pay_to?: string; network?: string; amount_micro?: string };
};

const clients = new WeakSet<object>();
const pending = new WeakMap<SpendLedger, Map<string, bigint>>();
const logs = new Map<string, ReturnType<typeof createFileDecisionLedger>>();
const HOUR_MS = 3_600_000;

function limit(value: string, name: string): bigint {
  if (typeof value !== "string") throw new TypeError(`${name} must be a USDC decimal string`);
  return toMicroUsd(value);
}

function recipientKey(value: string): string {
  return value.startsWith("0x") ? value.toLowerCase() : value;
}

/**
 * The buyer front door: exact local limits, mandatory fail-closed free
 * preflight, and local decision/spend records around the real paying fetch.
 * No paid scores, delivery capture or decision-reporting request is made.
 * Spend is committed before signing and conservatively retained on failure;
 * it records authorized attempts, not confirmed onchain settlement.
 */
export function createBuyerFetch(options: BuyerFetchOptions): typeof fetch {
  if (!options?.client || typeof options.client.onBeforePaymentCreation !== "function") {
    throw new TypeError("createBuyerFetch requires a configured x402 client");
  }
  if (clients.has(options.client as object)) throw new TypeError("createBuyerFetch already installed on this client");
  const client = options.client;
  const max = limit(options.maxPricePerCall, "maxPricePerCall");
  const hourly = options.hourlyBudgetCap === undefined ? undefined : limit(options.hourlyBudgetCap, "hourlyBudgetCap");
  if (!Array.isArray(options.allowedRecipients) || options.allowedRecipients.some(v => typeof v !== "string" || !v.trim())) {
    throw new TypeError("allowedRecipients must be an explicit array of recipient addresses");
  }
  const recipients = new Set(options.allowedRecipients.map(recipientKey));
  const decisionPath = resolve(options.decisionFile ?? ".twzrd/decisions.jsonl");
  const spendPath = resolve(options.spendLedgerFile ?? ".twzrd/spend.jsonl");
  if (decisionPath === spendPath) throw new TypeError("decisionFile and spendLedgerFile must be different files");
  const ledger = sharedFileSpendLedger(spendPath);
  let log = logs.get(decisionPath);
  if (!log) logs.set(decisionPath, (log = createFileDecisionLedger(decisionPath, { flushBeforeExit: false })));
  const decisions = log;
  const scope = `buyer-fetch:${options.budgetScope ?? "default"}`;
  let reservations = pending.get(ledger);
  if (!reservations) pending.set(ledger, (reservations = new Map()));
  const inFlight = reservations;
  const attempts = new AsyncLocalStorage<Attempt>();
  const raw = options.fetch ?? globalThis.fetch.bind(globalThis);
  // These guarantees are explicit, independent of legacy TWZRD_* bypasses.
  const cfg = resolveConfig({
    intelBase: options.intelBase ?? "https://intel.twzrd.xyz",
    intelTimeoutMs: options.intelTimeoutMs ?? 2000,
    fetch: options.preflightFetch ?? raw,
    failOpen: false,
    blockDecisions: ["block"],
    preflightMinScore: 40,
    gateOnCanSpend: false,
    refuseUnevaluated: false,
    refuseWashFlagged: true,
    refuseWashUnknown: false,
    unsupportedNetworkMode: "strict",
  });
  cfg.washMaxUsdc = null;
  cfg.attribution = undefined;

  async function record(attempt: Attempt, outcome: DecisionLedgerRow["outcome"], reason: string): Promise<void> {
    try {
      decisions.record({
        outcome, reason_codes: [reason], policy_version: "buyer-fetch.v1",
        input: attempt.input, signer_invocations: 0,
      });
      // A local record must be durable before this wrapper permits signing.
      await decisions.flush();
      attempt.recorded = true;
    } catch (cause) {
      attempt.blocked = new BuyerFetchBlockedError("decision_log_unavailable", { cause });
      throw attempt.blocked;
    }
  }
  async function refuse(attempt: Attempt, reason: string): Promise<never> {
    await record(attempt, "block", reason);
    attempt.blocked = new BuyerFetchBlockedError(reason);
    throw attempt.blocked;
  }

  client.onBeforePaymentCreation(async context => {
    const attempt = attempts.getStore();
    if (!attempt) throw new BuyerFetchBlockedError("use_buyer_fetch_for_payment");
    const selected = context.selectedRequirements ?? context.requirements ?? {};
    const fields = resolveRequirementFields(selected);
    attempt.input = { resource: attempt.resource, pay_to: fields.payTo,
      network: selected.network, amount_micro: fields.amount };
    if (fields.conflict) return refuse(attempt, fields.conflict);
    if (!fields.payTo) return refuse(attempt, "recipient_missing");
    if (!recipients.has(recipientKey(fields.payTo))) return refuse(attempt, "unauthorized_recipient");
    if (!isUsdcRequirement(selected)) return refuse(attempt, "unsupported_or_non_usdc_asset");
    if (fields.amount === undefined || !/^\d+$/.test(fields.amount)) return refuse(attempt, "amount_missing_or_malformed");
    const micro = BigInt(fields.amount);
    if (micro > max) return refuse(attempt, "price_cap_exceeded");
    if (micro > BigInt(Number.MAX_SAFE_INTEGER)) return refuse(attempt, "amount_out_of_range");
    const now = Date.now();
    if (hourly !== undefined && ledger.spentMicro(scope, HOUR_MS, now) + (inFlight.get(scope) ?? 0n) + micro > hourly) {
      return refuse(attempt, "hourly_budget_exceeded");
    }
    // Check and reserve in the same tick, across wrappers sharing this ledger.
    inFlight.set(scope, (inFlight.get(scope) ?? 0n) + micro);
    try {
      const approval = await twzrdApprovePayment({
        resourceUrl: attempt.resource, payTo: fields.payTo, chain: selected.network,
        asset: selected.asset, priceUsdc: Number(micro) / 1_000_000,
        agentIntent: "buyer_fetch",
      }, cfg);
      if (!approval.approved) return refuse(attempt, approval.reason.split(/[ (]/)[0]);
      if (approval.card.decision !== "allow" && approval.card.decision !== "warn") {
        return refuse(attempt, "invalid_preflight_decision");
      }
      if (attempt.signal?.aborted) return refuse(attempt, "request_aborted");
      await record(attempt, approval.verdict === "warn" ? "warn" : "allow", approval.reason);
      // Check abort again after the async disk write, immediately before commit/sign.
      if (attempt.signal?.aborted) return refuse(attempt, "request_aborted");
      try { ledger.record(scope, micro, Date.now()); }
      catch { return refuse(attempt, "spend_ledger_unavailable"); }
      attempt.approvedForSigning = true;
    } finally {
      const left = (inFlight.get(scope) ?? 0n) - micro;
      if (left > 0n) inFlight.set(scope, left); else inFlight.delete(scope);
    }
  });
  clients.add(client as object);

  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const current = attempts.getStore();
    if (current && !current.approvedForSigning &&
      (request.headers.has("payment-signature") || request.headers.has("x-payment"))) {
      return refuse(current, "payment_without_approval");
    }
    const response = await raw(request, { redirect: "error" });
    if (response.status === 402) {
      const attempt = attempts.getStore();
      if (attempt) attempt.challengeSeen = true;
    }
    return response;
  };
  let paying: Promise<typeof fetch> | undefined;
  return async (input, init) => {
    const request = new Request(input, init);
    const attempt: Attempt = { resource: request.url, signal: request.signal,
      challengeSeen: false, recorded: false, input: { resource: request.url } };
    return attempts.run(attempt, async () => {
      if (request.headers.has("payment-signature") || request.headers.has("x-payment")) {
        return refuse(attempt, "presigned_payment_not_allowed");
      }
      paying ??= import("@x402/fetch").then(({ wrapFetchWithPayment }) =>
        wrapFetchWithPayment(transport, client as never));
      try { return await (await paying)(request); }
      catch (error) {
        // @x402/fetch rewraps hook exceptions without their original class.
        if (attempt.blocked) throw attempt.blocked;
        if (error instanceof BuyerFetchBlockedError || attempt.recorded) throw error;
        // Core can refuse before calling our hook. Keep that refusal visible too.
        const reason = /spendControls/.test(String(error)) ? "core_spend_controls"
          : attempt.challengeSeen ? "payment_client_refused" : "request_failed";
        await record(attempt, attempt.challengeSeen ? "block" : "error", reason);
        throw new BuyerFetchBlockedError(reason, { cause: error });
      }
    });
  };
}
