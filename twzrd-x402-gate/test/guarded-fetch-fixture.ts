import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createGuardedX402Fetch as create, type GuardedX402FetchOptions } from "../src/guarded-x402-fetch.js";
export { decideHeldVaultSpend, explainCoreSpendControls, SETTLEMENT_USDC_MINT, VAULT_PROGRAM_ID } from "../src/guarded-x402-fetch.js";
export type { HeldVaultSpendCopy } from "../src/guarded-x402-fetch.js";

const files = new Set<string>();
process.once("exit", () => {
  for (const file of files) {
    try { rmSync(file, { force: true }); } catch { /* test cleanup */ }
    try { rmSync(`${file}.lock`, { force: true }); } catch { /* test cleanup */ }
  }
});

/** Give each legacy test client an isolated durable ledger unless it tests sharing explicitly. */
export function createGuardedX402Fetch(options: GuardedX402FetchOptions): typeof fetch {
  if (options.spendLedgerFile) return create(options);
  const file = resolve(tmpdir(), `twzrd-gate-test-spend-${process.pid}-${randomUUID()}.jsonl`);
  files.add(file);
  return create({ ...options, spendLedgerFile: file });
}
