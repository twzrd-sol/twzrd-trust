/**
 * Durable SpendLedger — append-only JSONL with a sha256 hash chain.
 *
 * The in-memory ledger resets on process death, which turns a crashlooping
 * agent into an unbounded spender: every restart re-opens its cumulative
 * budgets. This ledger replays its file on create so caps survive restarts,
 * and every row commits to the hash of the previous line so a silent edit or
 * truncation breaks the chain.
 *
 * Fail-closed: a missing file is a fresh ledger; an unparsable or
 * chain-broken file throws — a damaged spend record must never be read as
 * "nothing spent".
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { createMemorySpendLedger } from "./policy-runtime.js";
const GENESIS = "genesis";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export function createFileSpendLedger(filePath) {
    const inner = createMemorySpendLedger();
    let lastHash = GENESIS;
    let raw = "";
    try {
        raw = readFileSync(filePath, "utf8");
    }
    catch (err) {
        if (err.code !== "ENOENT")
            throw err;
        mkdirSync(dirname(filePath), { recursive: true });
    }
    for (const line of raw.split("\n")) {
        if (!line)
            continue;
        let row;
        try {
            row = JSON.parse(line);
        }
        catch {
            throw new Error(`[twzrd-x402-gate] spend ledger corrupt row: ${filePath}`);
        }
        if (row.prev !== lastHash || typeof row.micro !== "string") {
            throw new Error(`[twzrd-x402-gate] spend ledger chain broken: ${filePath}`);
        }
        inner.record(row.scope, BigInt(row.micro), row.at);
        lastHash = sha256(line);
    }
    return {
        spentMicro: (scopeKey, windowMs, now) => inner.spentMicro(scopeKey, windowMs, now),
        firstSeen: (scopeKey) => inner.firstSeen(scopeKey),
        record(scopeKey, amountMicro, at) {
            const line = JSON.stringify({
                at,
                scope: scopeKey,
                micro: amountMicro.toString(),
                prev: lastHash,
            });
            // Disk before memory: if the append fails, the spend must not be
            // counted as recorded anywhere.
            appendFileSync(filePath, line + "\n");
            lastHash = sha256(line);
            inner.record(scopeKey, amountMicro, at);
        },
    };
}
//# sourceMappingURL=spend-ledger-file.js.map