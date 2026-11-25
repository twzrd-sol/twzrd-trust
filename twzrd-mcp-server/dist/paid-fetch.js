import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { join } from "node:path";
import { x402Client } from "@x402/core/client";
import { createBuyerFetch } from "twzrd-x402-gate";
import { selectSolanaExact } from "./select-solana-exact.js";
import { refuseWashBeforePay } from "./wash-before-pay.js";
export const TWZRD_INTEL_PAYTO = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
export function defaultLedgerPaths(env = process.env) {
    const dir = join(homedir(), ".twzrd", "mcp");
    return {
        spendLedgerFile: env.TWZRD_MCP_SPEND_LEDGER_FILE?.trim() || join(dir, "spend-v2.jsonl"),
        decisionFile: env.TWZRD_MCP_DECISION_FILE?.trim() || join(dir, "decisions.jsonl"),
    };
}
export function usdDecimal(value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`spend cap must be a finite non-negative number, got ${value}`);
    }
    const micro = BigInt(Math.floor(Number((value * 1_000_000).toPrecision(12))));
    return `${micro / 1000000n}.${(micro % 1000000n).toString().padStart(6, "0")}`;
}
export function createPaymentClient(options) {
    const client = new x402Client(((version, accepts) => selectSolanaExact(version, accepts, {
        maxPerCall: options.maxPerCallUsdc,
        allowedRecipients: options.allowedRecipients,
    }).req));
    client.register(options.network, options.scheme);
    return client;
}
export function createPaidFetch(options) {
    const calls = new AsyncLocalStorage();
    const washCheck = options.washCheck ??
        ((option) => refuseWashBeforePay(option, {
            fetch: options.fetch,
            intelBase: options.intelBase,
            timeoutMs: options.washTimeoutMs,
        }));
    options.client.onBeforePaymentCreation(async (context) => {
        const call = calls.getStore();
        if (!call)
            return { abort: true, reason: "twzrd_use_paid_fetch" };
        call.payments += 1;
        if (call.payments > 1)
            return { abort: true, reason: "twzrd_one_payment_per_call" };
        await washCheck(context.selectedRequirements);
    });
    const buyer = createBuyerFetch({
        client: options.client,
        maxPricePerCall: usdDecimal(options.maxPerCallUsdc),
        hourlyBudgetCap: usdDecimal(options.hourlyCapUsdc),
        allowedRecipients: [...options.allowedRecipients],
        spendLedgerFile: options.spendLedgerFile,
        decisionFile: options.decisionFile,
        intelBase: options.intelBase,
        intelTimeoutMs: options.intelTimeoutMs,
        fetch: options.fetch,
        preflightFetch: options.fetch,
        buyerWallet: options.buyerWallet,
    });
    return ((input, init) => calls.run({ payments: 0 }, () => buyer(input, init)));
}
export function describePaymentError(error) {
    const parts = [];
    let current = error;
    for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
        const message = current instanceof Error ? current.message : String(current);
        if (message && !parts.includes(message))
            parts.push(message);
        current = current instanceof Error ? current.cause : undefined;
    }
    return parts.join(" <- ");
}
