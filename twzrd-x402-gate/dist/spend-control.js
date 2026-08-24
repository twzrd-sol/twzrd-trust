/**
 * Product `twzrd.safeFetch` — challenge-bound spend control.
 * Not the AgentCash CLI adapter (`./safe-fetch`, advisory_precheck).
 * maxSpend is both the per-call cap and the cumulative budget checked
 * against agent, merchant, and mandate keys (same number).
 * Durable spend uses wzrd-final #2183 `createFileSpendLedger` (hash-chained
 * JSONL) via `ledger`, `ledgerFile`, or TWZRD_SPEND_LEDGER_FILE — not a
 * second ledger type. Default remains in-memory so tests stay hermetic.
 */
import { toMicroUsd } from "./intent.js";
import { classifyNetwork } from "./network.js";
import { payToFromRequirements, pickRequirements, priceUsdcFromAmountMicro, } from "./payto.js";
import { createMemorySpendLedger, } from "./policy-runtime.js";
import { createFileSpendLedger } from "./spend-ledger-file.js";
import { rememberRawInvoice, stampResourceBind, } from "./resource-bind.js";
import { evaluateResourceBindLegsFromSvmTx } from "./resource-bind-tx.js";
import { resourceUrlFromPaymentRequired } from "./x402-client-hook.js";
function netOk(network, payTo, allow) {
    if (!allow?.length)
        return true;
    const c = classifyNetwork(network, payTo);
    const n = (network ?? "").toLowerCase();
    return allow.some((a) => {
        const x = a.toLowerCase();
        if (x === "solana")
            return c.kind === "solana";
        if (x === "base")
            return n.includes("base") || n.includes("8453") || (c.kind === "evm" && n.includes("8453"));
        return n.includes(x) || c.kind === x;
    });
}
export async function spendControlSafeFetch(url, opts = {}) {
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const file = opts.ledgerFile ?? process.env.TWZRD_SPEND_LEDGER_FILE;
    const ledger = opts.ledger ?? (file ? createFileSpendLedger(file) : createMemorySpendLedger());
    const res = await fetchImpl(url);
    if (res.status !== 402)
        return { verdict: "allow", response: res, signerInvocations: 0 };
    let body;
    try {
        body = (await res.clone().json());
    }
    catch {
        return { verdict: "block", reason: "unparseable_402", signerInvocations: 0 };
    }
    rememberRawInvoice(body, url);
    const list = (body.accepts ?? []);
    const filtered = opts.allowNetworks?.length
        ? list.filter((e) => netOk(String(e.network ?? ""), String(e.payTo ?? e.pay_to ?? ""), opts.allowNetworks))
        : list;
    if (opts.allowNetworks?.length && list.length > 0 && filtered.length === 0) {
        return { verdict: "block", reason: "network_not_allowed", signerInvocations: 0 };
    }
    const selected = pickRequirements(filtered.length ? filtered : []);
    if (!selected.resource) {
        const envUrl = resourceUrlFromPaymentRequired(body);
        if (envUrl)
            selected.resource = envUrl;
    }
    const { payTo, amountMicro, resource } = payToFromRequirements(selected);
    const network = selected.network;
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
    if (maxMicro != null) {
        for (const key of [agentKey, merchantKey, mandateKey]) {
            if (ledger.spentMicro(key, WIN, now) + spendMicro > maxMicro) {
                return { verdict: "block", reason: "over_cumulative_spend", signerInvocations: 0 };
            }
        }
    }
    let verdict = "allow";
    const price = priceUsdcFromAmountMicro(amountMicro) ?? 0;
    if (opts.preflight) {
        const card = await opts.preflight(payTo, price);
        if (card.decision === "block")
            return { verdict: "block", reason: "intel_block", signerInvocations: 0 };
        if (card.decision === "warn")
            verdict = "warn";
    }
    let stamped = null;
    if (opts.requireOfferBinding) {
        stamped = stampResourceBind(selected, body);
    }
    let response = res;
    let txb64;
    let signerInvocations = 0;
    if (opts.pay) {
        signerInvocations = 1;
        const paid = await opts.pay({ url, paymentRequired: body, selected });
        if (paid.response)
            response = paid.response;
        txb64 = paid.transactionBase64;
    }
    let receipt;
    if (opts.requireOfferBinding) {
        const leaf_hash = stamped?.leaf_hash ?? null;
        if (!txb64) {
            if (signerInvocations > 0) {
                ledger.record(agentKey, spendMicro, now);
                ledger.record(merchantKey, spendMicro, now);
                ledger.record(mandateKey, spendMicro, now);
            }
            return { verdict: "block", reason: "bind_required_no_settlement", signerInvocations, receipt: { strength: "refuse", leaf_hash, fact_type: "resource_bound" } };
        }
        const d = await evaluateResourceBindLegsFromSvmTx(txb64, {
            leaf_hash: leaf_hash ?? "", pay_to: payTo, asset: String(selected.asset ?? ""), amount_raw: String(amountMicro),
        });
        receipt = { strength: d.strength, leaf_hash: d.leaf_hash, fact_type: "resource_bound" };
        if (d.strength !== "hard") {
            if (signerInvocations > 0) {
                ledger.record(agentKey, spendMicro, now);
                ledger.record(merchantKey, spendMicro, now);
                ledger.record(mandateKey, spendMicro, now);
            }
            return { verdict: "block", reason: "bind_mismatch", receipt, signerInvocations, response };
        }
    }
    if (signerInvocations > 0 || !opts.pay) {
        ledger.record(agentKey, spendMicro, now);
        ledger.record(merchantKey, spendMicro, now);
        ledger.record(mandateKey, spendMicro, now);
    }
    return { verdict, response, receipt, signerInvocations };
}
export const twzrd = { safeFetch: spendControlSafeFetch };
//# sourceMappingURL=spend-control.js.map