/**
 * Product `twzrd.safeFetch` — challenge-bound spend control.
 * Not the AgentCash CLI adapter (`./safe-fetch`, advisory_precheck).
 * maxSpend is both the per-call cap and the cumulative budget checked
 * against agent, merchant, and mandate keys (same number).
 * Durable spend uses wzrd-final #2183 `createFileSpendLedger` (hash-chained
 * JSONL) via `ledger`, `ledgerFile`, or TWZRD_SPEND_LEDGER_FILE — not a
 * second ledger type. The default is one process-scoped in-memory ledger;
 * use `ledgerFile` for restart-safe cumulative enforcement.
 */
import { resolve as resolvePath } from "node:path";
import { toMicroUsd } from "./intent.js";
import { classifyNetwork } from "./network.js";
import {
  payToFromRequirements,
  pickRequirements,
  priceUsdcFromAmountMicro,
} from "./payto.js";
import {
  createMemorySpendLedger,
  type SpendLedger,
} from "./policy-runtime.js";
import { createFileSpendLedger } from "./spend-ledger-file.js";
import {
  rememberRawInvoice,
  resourceBindMemo,
  stampResourceBind,
  type ResourceBindReq,
} from "./resource-bind.js";
import { evaluateResourceBindLegsFromSvmTx } from "./resource-bind-tx.js";
import { resourceUrlFromPaymentRequired } from "./x402-client-hook.js";
import type { X402PaymentRequiredBody } from "./types.js";

export type SpendControlOptions = {
  maxSpend?: string;
  allowNetworks?: string[];
  requireOfferBinding?: boolean;
  fetch?: typeof fetch;
  pay?: (args: {
    url: string;
    paymentRequired: unknown;
    selected: Record<string, unknown>;
    /** Present after a hard bind-v1 verify on the compose path. */
    transactionBase64?: string;
  }) => Promise<{ transactionBase64?: string; response?: Response }>;
  /**
   * Build, but do not sign or submit, the bound SVM transaction. Required
   * with `requireOfferBinding`; the gate verifies these exact bytes before it
   * calls `pay()`.
   */
  composeBoundTransaction?: (args: {
    url: string;
    paymentRequired: unknown;
    selected: Record<string, unknown>;
    leafHash: string;
    memo: string;
  }) => Promise<{ transactionBase64?: string }>;
  preflight?: (payTo: string, priceUsdc: number) => Promise<{ decision?: string }>;
  ledger?: SpendLedger;
  /** Path for #2183 file ledger when `ledger` is omitted. */
  ledgerFile?: string;
  agentId?: string;
  mandateId?: string;
};

export type SpendControlResult = {
  verdict: "allow" | "warn" | "block";
  reason?: string;
  response?: Response;
  receipt?: { strength: string; leaf_hash: string | null; fact_type: "resource_bound" };
  signerInvocations: number;
};

export type OfferBindingCheck = {
  verdict: "allow" | "block";
  reason?: string;
  receipt: { strength: string; leaf_hash: string | null; fact_type: "resource_bound" };
};

/** Shared shape for a bind-v1 check that never reached verification. */
function refuseBindReceipt(leaf_hash: string | null): OfferBindingCheck["receipt"] {
  return { strength: "refuse", leaf_hash, fact_type: "resource_bound" };
}

/**
 * Bind-v1 check on the composed, not-yet-submitted transaction. Despite the
 * name (kept for compat with the 0.9.2 call site), `spendControlSafeFetch`
 * calls this BEFORE `pay()`: compose, then verify these exact bytes, then pay.
 */
export async function verifyOfferBindingAfterPay(args: {
  transactionBase64?: string;
  leafHash: string | null;
  payTo: string;
  asset: string;
  amountRaw: string;
}): Promise<OfferBindingCheck> {
  const leaf_hash = args.leafHash ?? null;
  if (!args.transactionBase64) {
    return {
      verdict: "block",
      reason: "bind_required_no_settlement",
      receipt: refuseBindReceipt(leaf_hash),
    };
  }
  if (!leaf_hash) {
    // Distinct from "no settlement": a caller invoking this exported check
    // directly with no expected leaf hash cannot get a "hard" result — make
    // that an explicit refusal instead of silently verifying against "".
    return {
      verdict: "block",
      reason: "bind_required_no_leaf_hash",
      receipt: refuseBindReceipt(leaf_hash),
    };
  }
  const d = await evaluateResourceBindLegsFromSvmTx(args.transactionBase64, {
    leaf_hash,
    pay_to: args.payTo,
    asset: args.asset,
    amount_raw: args.amountRaw,
  });
  const receipt: OfferBindingCheck["receipt"] = {
    strength: d.strength,
    leaf_hash: d.leaf_hash,
    fact_type: "resource_bound",
  };
  if (d.strength !== "hard") {
    return { verdict: "block", reason: "bind_mismatch", receipt };
  }
  return { verdict: "allow", receipt };
}

/**
 * Default cumulative enforcement must outlive an individual safeFetch call.
 * It is process-scoped only; callers that need restart safety must provide
 * `ledger` or `ledgerFile`. A file ledger is shared per resolved path within
 * this process (so concurrent calls append to one hash chain); it is not
 * multi-process safe — serialize across processes externally.
 */
const defaultMemoryLedger = createMemorySpendLedger();
const fileLedgers = new Map<string, SpendLedger>();

function fileLedgerFor(file: string): SpendLedger {
  const path = resolvePath(file);
  let ledger = fileLedgers.get(path);
  if (!ledger) {
    ledger = createFileSpendLedger(path);
    fileLedgers.set(path, ledger);
  }
  return ledger;
}

/**
 * In-flight reservations per ledger, so concurrent calls in this process see
 * each other inside the check → pay → record window. Without this the
 * cumulative cap is a TOCTOU: two parallel calls both read spent=0, both
 * pass, both pay (W-2026-0902 #1).
 */
const pendingByLedger = new WeakMap<SpendLedger, Map<string, bigint>>();

function pendingFor(ledger: SpendLedger): Map<string, bigint> {
  let pending = pendingByLedger.get(ledger);
  if (!pending) pendingByLedger.set(ledger, (pending = new Map()));
  return pending;
}

/** Reserve `micro` under each key; returns the (idempotent) release. */
function reserveSpend(pending: Map<string, bigint>, keys: string[], micro: bigint): () => void {
  for (const key of keys) pending.set(key, (pending.get(key) ?? 0n) + micro);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const left = (pending.get(key) ?? 0n) - micro;
      if (left > 0n) pending.set(key, left);
      else pending.delete(key);
    }
  };
}

function netOk(network: string | undefined, payTo: string | undefined, allow?: string[]): boolean {
  if (!allow?.length) return true;
  const c = classifyNetwork(network, payTo);
  const n = (network ?? "").toLowerCase();
  return allow.some((a) => {
    const x = a.toLowerCase();
    if (x === "solana") return c.kind === "solana";
    if (x === "base") return n.includes("base") || n.includes("8453") || (c.kind === "evm" && n.includes("8453"));
    return n.includes(x) || c.kind === x;
  });
}

export async function spendControlSafeFetch(
  url: string,
  opts: SpendControlOptions = {},
): Promise<SpendControlResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const file = opts.ledgerFile ?? process.env.TWZRD_SPEND_LEDGER_FILE;
  const ledger = opts.ledger ?? (file ? fileLedgerFor(file) : defaultMemoryLedger);
  const res = await fetchImpl(url);
  if (res.status !== 402) return { verdict: "allow", response: res, signerInvocations: 0 };
  let body: X402PaymentRequiredBody;
  try {
    body = (await res.clone().json()) as X402PaymentRequiredBody;
  } catch {
    return { verdict: "block", reason: "unparseable_402", signerInvocations: 0 };
  }
  rememberRawInvoice(body, url);
  const list = (body.accepts ?? []) as Array<Record<string, unknown>>;
  const filtered = opts.allowNetworks?.length
    ? list.filter((e) => netOk(String(e.network ?? ""), String(e.payTo ?? e.pay_to ?? ""), opts.allowNetworks))
    : list;
  if (opts.allowNetworks?.length && list.length > 0 && filtered.length === 0) {
    return { verdict: "block", reason: "network_not_allowed", signerInvocations: 0 };
  }
  const selected = pickRequirements(filtered.length ? filtered : []) as Record<string, unknown>;
  if (!selected.resource) {
    const envUrl = resourceUrlFromPaymentRequired(body);
    if (envUrl) selected.resource = envUrl;
  }
  const { payTo, amountMicro, resource } = payToFromRequirements(selected as never);
  const network = selected.network as string | undefined;
  if (!payTo || amountMicro == null) {
    return { verdict: "block", reason: "no_payable_requirement", signerInvocations: 0 };
  }
  const spendMicro = BigInt(String(amountMicro).split(".")[0] || "0");
  const maxMicro = opts.maxSpend != null ? toMicroUsd(opts.maxSpend) : undefined;
  if (maxMicro != null && spendMicro > maxMicro) {
    return { verdict: "block", reason: "over_max_spend", signerInvocations: 0 };
  }
  const now = Date.now();
  const WIN = 365 * 24 * 3600 * 1000;
  const agentKey = `agent:${opts.agentId ?? "default"}`;
  const merchantKey = `merchant:${payTo}`;
  const mandateKey = `mandate:${opts.mandateId ?? "default"}`;
  const recordSpend = () => {
    ledger.record(agentKey, spendMicro, now);
    ledger.record(merchantKey, spendMicro, now);
    ledger.record(mandateKey, spendMicro, now);
  };
  const keys = [agentKey, merchantKey, mandateKey];
  let release = (): void => {};
  if (maxMicro != null) {
    const pending = pendingFor(ledger);
    for (const key of keys) {
      if (ledger.spentMicro(key, WIN, now) + (pending.get(key) ?? 0n) + spendMicro > maxMicro) {
        return { verdict: "block", reason: "over_cumulative_spend", signerInvocations: 0 };
      }
    }
    // No await between the check above and this reservation: that is what
    // makes check+reserve atomic for concurrent calls on this event loop.
    release = reserveSpend(pending, keys, spendMicro);
  }
  try {
    let verdict: "allow" | "warn" | "block" = "allow";
    const price = priceUsdcFromAmountMicro(amountMicro) ?? 0;
    if (opts.preflight) {
      const card = await opts.preflight(payTo, price);
      if (card.decision === "block") return { verdict: "block", reason: "intel_block", signerInvocations: 0 };
      if (card.decision === "warn") verdict = "warn";
    }
    let stamped = null as ReturnType<typeof stampResourceBind> | null;
    if (opts.requireOfferBinding) {
      stamped = stampResourceBind(selected as ResourceBindReq, body);
    }
    let response = res;
    let txb64: string | undefined;
    let signerInvocations = 0;
    if (opts.requireOfferBinding) {
      const leaf_hash = stamped?.leaf_hash ?? null;
      const refuseNoCompose = (): SpendControlResult => ({
        verdict: "block",
        reason: "bind_required_no_compose",
        signerInvocations: 0,
        receipt: refuseBindReceipt(leaf_hash),
      });
      if (!leaf_hash || !opts.composeBoundTransaction) {
        return refuseNoCompose();
      }
      const composed = await opts.composeBoundTransaction({
        url, paymentRequired: body, selected, leafHash: leaf_hash,
        memo: resourceBindMemo(leaf_hash),
      });
      txb64 = composed.transactionBase64;
      if (!txb64) {
        return refuseNoCompose();
      }
      const checked = await verifyOfferBindingAfterPay({
        transactionBase64: txb64,
        leafHash: leaf_hash,
        payTo,
        asset: String(selected.asset ?? ""),
        amountRaw: String(amountMicro),
      });
      const receipt = checked.receipt;
      if (checked.verdict === "block") {
        return { verdict: "block", reason: checked.reason ?? "bind_mismatch", receipt, signerInvocations: 0 };
      }
      if (opts.pay) {
        signerInvocations = 1;
        const paid = await opts.pay({ url, paymentRequired: body, selected, transactionBase64: txb64 });
        if (paid.response) response = paid.response;
      }
      if (signerInvocations > 0) recordSpend();
      return { verdict, response, receipt, signerInvocations };
    }
    if (opts.pay) {
      signerInvocations = 1;
      const paid = await opts.pay({ url, paymentRequired: body, selected });
      if (paid.response) response = paid.response;
    }
    let receipt: SpendControlResult["receipt"];
    if (signerInvocations > 0) recordSpend();
    return { verdict, response, receipt, signerInvocations };
  } finally {
    // Runs after recordSpend() on the success paths (both synchronous), so
    // there is no instant where neither the record nor the reservation counts.
    release();
  }
}

export const twzrd = { safeFetch: spendControlSafeFetch };
