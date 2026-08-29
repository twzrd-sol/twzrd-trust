/**
 * Append-only decision ledger for support, evaluation, and settlement joins.
 * Rows deliberately carry a schema version: readers must reject formats they
 * do not understand rather than silently misinterpret an audit record.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const DECISION_LEDGER_SCHEMA_VERSION = 1;

export type DecisionLedgerRow = {
  schema_version: typeof DECISION_LEDGER_SCHEMA_VERSION;
  decision_id: string;
  at_unix_ms: number;
  outcome: "allow" | "warn" | "block" | "error";
  reason_codes: string[];
  policy_version: string;
  input: {
    pay_to?: string;
    resource?: string;
    network?: string;
    amount_micro?: string;
  };
  signer_invocations: number;
  latency_ms?: number;
  error?: { code: string; message?: string };
  settlement?: { status: "pending" | "settled" | "failed"; tx?: string };
};

export type RecordDecisionInput = Omit<DecisionLedgerRow, "schema_version" | "decision_id" | "at_unix_ms"> & {
  decision_id?: string;
  at_unix_ms?: number;
};

export function createFileDecisionLedger(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  return {
    record(input: RecordDecisionInput): DecisionLedgerRow {
      const row: DecisionLedgerRow = {
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
