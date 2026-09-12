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
// --verify re-checks an ALREADY PUBLISHED bundle. Offline and deterministic,
// so a foreign operator reaches the same verdict TWZRD would.
const verify = process.argv.includes("--verify");
const dist = join(pkgRoot, "dist", verify ? "evidence-verify.js" : "evidence-bundle.js");

if (!existsSync(dist)) {
  console.error("twzrd-evidence-bundle: run `npm run build` in twzrd-x402-gate or install the published package");
  process.exit(2);
}

const mod = await import(pathToFileURL(dist).href);
if (verify) {
  const code = await mod.mainVerify(process.argv.slice(2).filter((a) => a !== "--verify"));
  process.exit(code);
}
await mod.main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
