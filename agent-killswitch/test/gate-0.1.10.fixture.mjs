// Reference oracle for test/prompt-estimate.test.mjs. Do not edit.
// This is the TypeScript compiler output for src/gate.ts at commit
// 34fa85b0c5955f3421c3cb545297762aa825cd31 (before the prompt-token bound),
// unchanged except for the pricing import path. src/gate.ts at that commit
// is the same file as in the published 0.1.10
// (51c04bbe9f864fac8a6511bc0663747c9ab60881), so this is the 0.1.10 gate.
// src/pricing.ts is the same file in both trees.
import * as fs from "node:fs";
import * as path from "node:path";
import { pessimisticRequestCostUsd, priceFor } from "../dist/pricing.js";
export const PAUSE_SENTINEL_SCHEMA = "twzrd.pause_sentinel.v1";
/** Instant kill switch: the mere existence of the file vetoes everything. */
export function checkKillSwitch(filePath) {
    try {
        return fs.existsSync(filePath);
    }
    catch {
        // If we cannot even stat the file, fail closed.
        return true;
    }
}
/**
 * Payment-gate backpressure sentinel (.pause).
 *
 * - Missing file (ENOENT): not paused.
 * - Unreadable, non-JSON, unknown schema, or invalid until_unix_ms: fail closed (paused=true, corrupt=true).
 * - Valid until_unix_ms > now: paused (429 payment_gate_halt).
 * - Valid until_unix_ms <= now: expired, not paused (allows requests without mutating disk).
 */
export function checkPauseSwitch(filePath, now = Date.now()) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return {
                paused: false,
                corrupt: false,
                expired: false,
                untilUnixMs: null,
                reason: null,
                decisionId: null,
            };
        }
        return {
            paused: true,
            corrupt: true,
            expired: false,
            untilUnixMs: null,
            reason: "corrupt_pause_sentinel",
            decisionId: null,
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return {
            paused: true,
            corrupt: true,
            expired: false,
            untilUnixMs: null,
            reason: "corrupt_pause_sentinel",
            decisionId: null,
        };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
            paused: true,
            corrupt: true,
            expired: false,
            untilUnixMs: null,
            reason: "corrupt_pause_sentinel",
            decisionId: null,
        };
    }
    const obj = parsed;
    if ("schema" in obj && obj["schema"] !== PAUSE_SENTINEL_SCHEMA) {
        return {
            paused: true,
            corrupt: true,
            expired: false,
            untilUnixMs: null,
            reason: "corrupt_pause_sentinel",
            decisionId: null,
        };
    }
    const until = obj["until_unix_ms"];
    if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) {
        return {
            paused: true,
            corrupt: true,
            expired: false,
            untilUnixMs: null,
            reason: "corrupt_pause_sentinel",
            decisionId: null,
        };
    }
    const reason = typeof obj["reason"] === "string" && obj["reason"].trim().length > 0
        ? obj["reason"].trim()
        : null;
    const decisionId = typeof obj["decision_id"] === "string" && obj["decision_id"].trim().length > 0
        ? obj["decision_id"].trim()
        : null;
    if (now < until) {
        return {
            paused: true,
            corrupt: false,
            expired: false,
            untilUnixMs: until,
            reason: reason ?? "payment_gate_halt",
            decisionId,
        };
    }
    return {
        paused: false,
        corrupt: false,
        expired: true,
        untilUnixMs: until,
        reason,
        decisionId,
    };
}
/**
 * Atomically write a `.pause` sentinel (temp file + fsync + rename) when a
 * budget cap is breached so the sibling payment gate halts for the cap window.
 */
export function writePauseSwitch(filePath, input) {
    if (typeof input.ttlMs !== "number" || !Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
        return;
    }
    const now = input.now ?? Date.now();
    const payload = {
        schema: PAUSE_SENTINEL_SCHEMA,
        until_unix_ms: Math.floor(now + input.ttlMs),
        reason: String(input.reason ?? "").trim() || "budget_exceeded",
        ...(input.decisionId ? { decision_id: input.decisionId } : {}),
    };
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${now}.tmp`;
    const fd = fs.openSync(tmpPath, "w", 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(payload) + "\n", "utf8");
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
}
/**
 * Pre-call estimate, used both by evaluateGate and by the in-flight hold.
 * With max_tokens: all of them at the output rate. Without it there is no
 * token estimate, and the dollar estimate is the per-request cap, except for
 * a model priced at $0 (see priceFor), which holds no dollars.
 */
export function requestEstimate(model, maxTokens, maxCostPerRequestUsd, freeModels, rates) {
    if (maxTokens === null) {
        const { price } = priceFor(model, freeModels, rates);
        const free = price.inputPerMTok === 0 && price.outputPerMTok === 0;
        return { tokens: 0, usd: free ? 0 : maxCostPerRequestUsd };
    }
    return { tokens: maxTokens, usd: pessimisticRequestCostUsd(model, maxTokens, freeModels, rates) };
}
/** Pure pre-call budget evaluator. No I/O, no tokenizer. The window must include in-flight holds. */
export function evaluateGate(input) {
    if (input.killed) {
        return {
            allowed: false,
            status: 403,
            code: "kill_switch",
            message: "Kill switch engaged",
            spentUsd: input.window.hourUsd,
            limitUsd: input.maxUsdPerHour,
        };
    }
    if (input.paused && input.pauseReason !== "budget_exceeded") {
        const detail = input.pauseReason ? `: ${input.pauseReason}` : "";
        return {
            allowed: false,
            status: 429,
            code: "payment_gate_halt",
            message: `Payment gate pause active${detail}`,
            spentUsd: input.window.hourUsd,
            limitUsd: input.maxUsdPerHour,
            decisionId: input.pauseDecisionId ?? null,
        };
    }
    if (input.allowedModels && input.allowedModels.length > 0 && !input.allowedModels.includes(input.model)) {
        return {
            allowed: false,
            status: 403,
            code: "model_not_allowed",
            message: "model is not on the free allowlist",
            spentUsd: 0,
            limitUsd: 0,
        };
    }
    // The same estimate the caller holds while the request is in flight.
    const est = requestEstimate(input.model, input.maxTokens, input.maxCostPerRequestUsd, input.zeroPriceModels, input.modelRates);
    // Token velocity gate: tokens in the last 60 s (recorded and in flight)
    // plus this request's max_tokens as a stand-in for its eventual size.
    if (input.window.minuteTokens + est.tokens > input.maxTokensPerMinute) {
        return {
            allowed: false,
            status: 429,
            code: "budget_exceeded",
            message: `Token-per-minute limit ${input.maxTokensPerMinute} would be exceeded`,
            spentUsd: input.window.minuteTokens,
            limitUsd: input.maxTokensPerMinute,
            pauseWindowMs: 60_000,
        };
    }
    // Pessimistic cost gate: every requested max_token bills at the output
    // rate. Without max_tokens the request is assumed to cost the per-request
    // cap, so the hourly and daily checks still run.
    if (est.usd > input.maxCostPerRequestUsd) {
        return {
            allowed: false,
            status: 429,
            code: "per_request_cap",
            message: `Request could cost $${est.usd.toFixed(4)}, over the per-request cap $${input.maxCostPerRequestUsd.toFixed(2)}`,
            spentUsd: est.usd,
            limitUsd: input.maxCostPerRequestUsd,
        };
    }
    if (input.window.hourUsd + est.usd > input.maxUsdPerHour) {
        return {
            allowed: false,
            status: 429,
            code: "budget_exceeded",
            message: `Hourly limit $${input.maxUsdPerHour.toFixed(2)} would be exceeded`,
            spentUsd: input.window.hourUsd,
            limitUsd: input.maxUsdPerHour,
            pauseWindowMs: 3_600_000,
        };
    }
    if (input.window.dayUsd + est.usd > input.maxUsdPerDay) {
        return {
            allowed: false,
            status: 429,
            code: "budget_exceeded",
            message: `Daily limit $${input.maxUsdPerDay.toFixed(2)} would be exceeded`,
            spentUsd: input.window.dayUsd,
            limitUsd: input.maxUsdPerDay,
            pauseWindowMs: 86_400_000,
        };
    }
    // Hard caps apply even without max_tokens: an already-blown window vetoes.
    if (input.window.hourUsd >= input.maxUsdPerHour) {
        return {
            allowed: false,
            status: 429,
            code: "budget_exceeded",
            message: `Hourly limit $${input.maxUsdPerHour.toFixed(2)} hit`,
            spentUsd: input.window.hourUsd,
            limitUsd: input.maxUsdPerHour,
            pauseWindowMs: 3_600_000,
        };
    }
    if (input.window.dayUsd >= input.maxUsdPerDay) {
        return {
            allowed: false,
            status: 429,
            code: "budget_exceeded",
            message: `Daily limit $${input.maxUsdPerDay.toFixed(2)} hit`,
            spentUsd: input.window.dayUsd,
            limitUsd: input.maxUsdPerDay,
            pauseWindowMs: 86_400_000,
        };
    }
    if (input.paused) {
        const detail = input.pauseReason ? `: ${input.pauseReason}` : "";
        return {
            allowed: false,
            status: 429,
            code: "payment_gate_halt",
            message: `Payment gate pause active${detail}`,
            spentUsd: input.window.hourUsd,
            limitUsd: input.maxUsdPerHour,
            decisionId: input.pauseDecisionId ?? null,
        };
    }
    return { allowed: true, status: 200, code: null, message: "allowed", spentUsd: 0, limitUsd: 0 };
}
/** OpenAI-shaped veto body so agent frameworks handle it like a normal API error. */
export function vetoBody(decision) {
    return {
        error: {
            type: "killswitch_veto",
            code: decision.code,
            message: decision.message,
            spent_usd: round4(decision.spentUsd),
            limit_usd: decision.limitUsd,
            ...(decision.decisionId ? { decision_id: decision.decisionId } : {}),
        },
    };
}
function round4(n) {
    return Math.round(n * 10000) / 10000;
}
