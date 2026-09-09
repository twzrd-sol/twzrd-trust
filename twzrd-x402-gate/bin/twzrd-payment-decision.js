#!/usr/bin/env node
/**
 * Verify a twzrd.payment_decision.v1 record offline.
 *
 *   npx twzrd-payment-decision --verify record.json --pubkey issuer.spki.pem
 *   npx twzrd-payment-decision --verify record.json --pubkey issuer.spki.pem --challenge accepts-entry.json --json
 *
 * Exit 0 = accept, 1 = reject, 2 = usage / unreadable input. No network.
 * Spec: docs/payment-decision-v1-spec.md.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkgRoot, "dist", "payment-decision.js");

if (!existsSync(dist)) {
  console.error("twzrd-payment-decision: run `npm run build` in twzrd-x402-gate or install the published package");
  process.exit(2);
}

const mod = await import(pathToFileURL(dist).href);
const code = await mod.mainVerify(process.argv.slice(2).filter((a) => a !== "--verify"));
process.exit(code);
