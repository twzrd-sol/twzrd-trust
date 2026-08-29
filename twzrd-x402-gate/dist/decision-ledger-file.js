/**
 * Append-only decision ledger for support, evaluation, and settlement joins.
 * Rows deliberately carry a schema version: readers must reject formats they
 * do not understand rather than silently misinterpret an audit record.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export const DECISION_LEDGER_SCHEMA_VERSION = 1;
export function createFileDecisionLedger(filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    return {
        record(input) {
            const row = {
                ...input,
                schema_version: DECISION_LEDGER_SCHEMA_VERSION,
                decision_id: input.decision_id ?? randomUUID(),
                at_unix_ms: input.at_unix_ms ?? Date.now(),
            };
            appendFileSync(filePath, JSON.stringify(row) + "\n", { encoding: "utf8" });
            return row;
        },
    };
}
//# sourceMappingURL=decision-ledger-file.js.map