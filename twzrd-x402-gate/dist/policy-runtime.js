/**
 * TWZRD Payment Control — the protocol-neutral policy runtime.
 *
 * `evaluateIntent(intent, { policy, mandate, intelligence })` combines:
 *   - LOCAL hard controls (ceilings, network/asset restrictions, allow/block
 *     lists, mandate validation, cumulative caps, recurring price checks) —
 *     deterministic, no network, keeps working through an API outage;
 *   - REMOTE intelligence (counterparty score, wash/fleet detection) via an
 *     injectable async provider;
 * and returns a signed, expiring DecisionToken bound to the intent hash.
 *
 * Deliberately NOT a policy language. Five concrete policies, evaluated in a
 * fixed order with stable reason codes.
 */
import { newDecisionId, normalizeCitedOutcomes, signDecision, } from "./decision-token.js";
import { fromMicroUsd, intentHash, toMicroUsd } from "./intent.js";
export const POLICY_VERSION = "twzrd-pc-v1";
/** Agent-facing budget refuse code (maps POLICY_MAX_AMOUNT / monthly ceiling). */
export const TWZRD_BUDGET_EXCEEDED = "twzrd_budget_exceeded";
export function createMemorySpendLedger() {
    const entries = new Map();
    const first = new Map();
    return {
        spentMicro(scopeKey, windowMs, now) {
            const list = entries.get(scopeKey) ?? [];
            let total = 0n;
            for (const e of list)
                if (now - e.at <= windowMs)
                    total += e.micro;
            return total;
        },
        record(scopeKey, amountMicro, at) {
            const list = entries.get(scopeKey) ?? [];
            list.push({ at, micro: amountMicro });
            entries.set(scopeKey, list);
            if (!first.has(scopeKey))
                first.set(scopeKey, at);
        },
        firstSeen(scopeKey) {
            return first.get(scopeKey);
        },
    };
}
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Evaluate one PaymentIntent. Never throws on a policy outcome — a block is a
 * signed block decision (auditable), not an exception. Throws only on
 * malformed input (bad amounts) or signer failure.
 */
export async function evaluateIntent(intent, options) {
    const now = options.now ?? Date.now();
    const { policy, mandate } = options;
    const amountMicro = toMicroUsd(intent.amount);
    const reasons = [];
    let blocked = false;
    let warned = false;
    /** Set only when a budget ceiling blocks; last writer wins if both fire. */
    let budgetRemainingUsdc;
    const block = (code) => {
        blocked = true;
        reasons.push(code);
    };
    const warn = (code) => {
        warned = true;
        reasons.push(code);
    };
    const blockBudget = (technicalCode, remainingMicro) => {
        block(technicalCode);
        if (!reasons.includes(TWZRD_BUDGET_EXCEEDED))
            block(TWZRD_BUDGET_EXCEEDED);
        budgetRemainingUsdc = fromMicroUsd(remainingMicro < 0n ? 0n : remainingMicro);
    };
    /* 1. Mandate validation (local, deterministic) */
    if (mandate) {
        if (mandate.expiresAt && now >= Date.parse(mandate.expiresAt)) {
            block("MANDATE_EXPIRED");
        }
        if (mandate.purposes && !mandate.purposes.includes(intent.context?.purpose ?? "")) {
            block("MANDATE_PURPOSE");
        }
        if (mandate.resourceAllow) {
            const url = intent.resource?.url ?? "";
            if (!mandate.resourceAllow.some((prefix) => url.startsWith(prefix))) {
                block("MANDATE_RESOURCE_SCOPE");
            }
        }
        if (mandate.payeeBlocklist?.includes(intent.payTo)) {
            block("MANDATE_PAYEE_BLOCKED");
        }
        if (mandate.maxPerTransactionUsd !== undefined &&
            amountMicro > toMicroUsd(mandate.maxPerTransactionUsd)) {
            // Per-tx mandate ceiling is also a budget refuse for agents.
            blockBudget("MANDATE_MAX_PER_TX", toMicroUsd(mandate.maxPerTransactionUsd));
        }
        if (mandate.monthlyCeilingUsd !== undefined && options.ledger) {
            const spent = options.ledger.spentMicro(`mandate:${mandate.mandateId}`, MONTH_MS, now);
            const ceiling = toMicroUsd(mandate.monthlyCeilingUsd);
            if (spent + amountMicro > ceiling) {
                const remaining = ceiling > spent ? ceiling - spent : 0n;
                blockBudget("MANDATE_MONTHLY_CEILING", remaining);
            }
        }
    }
    /* 2. Company policy — local hard controls */
    if (policy) {
        if (policy.blocklist?.includes(intent.payTo))
            block("POLICY_BLOCKLIST");
        if (policy.allowlist && !policy.allowlist.includes(intent.payTo)) {
            block("POLICY_NOT_ALLOWLISTED");
        }
        if (policy.allowedNetworks && !policy.allowedNetworks.includes(intent.network)) {
            block("POLICY_NETWORK");
        }
        if (policy.allowedAssets && !policy.allowedAssets.includes(intent.asset)) {
            block("POLICY_ASSET");
        }
        if (policy.maxAmountUsd !== undefined && amountMicro > toMicroUsd(policy.maxAmountUsd)) {
            // Remaining headroom for a compliant retry is the per-tx cap itself.
            blockBudget("POLICY_MAX_AMOUNT", toMicroUsd(policy.maxAmountUsd));
        }
        if (policy.recurringMaxPriceIncreasePct !== undefined &&
            intent.context?.recurring &&
            intent.context.priorSpend) {
            const prior = toMicroUsd(intent.context.priorSpend);
            const ceiling = prior + (prior * BigInt(Math.round(policy.recurringMaxPriceIncreasePct * 100))) / 10000n;
            if (amountMicro > ceiling)
                block("RECURRING_PRICE_INCREASE");
        }
        if (policy.newCounterpartyCap && options.ledger) {
            const windowMs = policy.newCounterpartyCap.windowHours * 3_600_000;
            const scope = `counterparty:${intent.payTo}`;
            const seen = options.ledger.firstSeen(scope);
            const isNew = seen === undefined || now - seen <= windowMs;
            if (isNew) {
                const spent = options.ledger.spentMicro(scope, windowMs, now);
                if (spent + amountMicro > toMicroUsd(policy.newCounterpartyCap.capUsd)) {
                    block("NEW_COUNTERPARTY_CAP");
                }
            }
        }
    }
    /* 3. Remote intelligence (skipped when already blocked locally) */
    if (!blocked && options.intelligence) {
        const intel = await options.intelligence(intent);
        if (intel.washFlagged && policy?.refuseWashFlagged !== false) {
            block("WASH_FLAGGED");
        }
        if (intel.decision === "block")
            block("INTEL_BLOCK");
        if (intel.decision === "warn")
            warn("INTEL_WARN");
        if (policy?.unknownCounterparty && intel.known === false) {
            if (amountMicro <= toMicroUsd(policy.unknownCounterparty.allowUnderUsd)) {
                warn("UNKNOWN_UNDER_LIMIT");
            }
            else if (policy.unknownCounterparty.aboveAction === "warn") {
                warn("UNKNOWN_ABOVE_LIMIT");
            }
            else {
                block("UNKNOWN_ABOVE_LIMIT");
            }
        }
    }
    const verdict = blocked ? "block" : warned ? "warn" : "allow";
    if (verdict === "allow" && reasons.length === 0)
        reasons.push("ALLOW");
    /* 4. Record spend that will be permitted (feeds cumulative/monthly caps) */
    if (!blocked && options.ledger && options.recordSpend !== false) {
        options.ledger.record(`counterparty:${intent.payTo}`, amountMicro, now);
        if (mandate)
            options.ledger.record(`mandate:${mandate.mandateId}`, amountMicro, now);
    }
    /* 5. Signed, expiring token bound to the exact intent */
    const cited = options.citedOutcomes?.length
        ? normalizeCitedOutcomes(options.citedOutcomes)
        : undefined;
    return signDecision({
        decision: verdict,
        reasonCodes: reasons,
        intentHash: intentHash(intent),
        policyVersion: POLICY_VERSION,
        decisionId: newDecisionId(),
        expiresAt: new Date(now + (options.ttlMs ?? 120_000)).toISOString(),
        ...(cited ? { citedOutcomes: cited } : {}),
        ...(budgetRemainingUsdc !== undefined
            ? { budgetRemainingUsdc }
            : {}),
    }, options.signer);
}
//# sourceMappingURL=policy-runtime.js.map