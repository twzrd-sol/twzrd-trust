#!/usr/bin/env node
/**
 * Export a twzrd.evidence_bundle.v1 from the no-spend adoption harness.
 *
 *   npx twzrd-evidence-bundle --integration acme-ops-agent-v1 --run-id "$(uuidgen)"
 *   npx twzrd-evidence-bundle --integration acme-ops-agent-v1 --run-id <uuid> --out bundle.json
 *
 * Correlation evidence only — not EXTERNAL_RUN by itself.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkgRoot, "dist", "evidence-bundle.js");

if (!existsSync(dist)) {
  console.error("twzrd-evidence-bundle: run `npm run build` in twzrd-x402-gate or install the published package");
  process.exit(2);
}

const { main } = await import(pathToFileURL(dist).href);
await main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
