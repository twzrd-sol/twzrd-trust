#!/usr/bin/env node
/**
 * Cold-start buyer loop — zero spend.
 *
 * Probe a pinned foreign x402 diet, run AutoGate (refuse wash) before any
 * signer, write default-deny policy.json, hop once from the resource join.
 * Nothing here signs or spends. Self-serve transcript, not EXTERNAL_RUN.
 *
 * Usage (after npm run build, or from the published package):
 *   npx twzrd-cold-start
 *   node node_modules/twzrd-x402-gate/bin/twzrd-cold-start.js --no-hop
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function loadCli() {
  const dist = join(pkgRoot, "dist", "cold-start.js");
  if (existsSync(dist)) return import(pathToFileURL(dist).href);
  console.error(
    "twzrd-cold-start: run `npm run build` in twzrd-x402-gate or install the published package",
  );
  process.exit(2);
}

async function main() {
  const { parseArgs, runColdStart, USAGE, HelpError } = await loadCli();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof HelpError || (e instanceof Error && e.name === "HelpError")) {
      console.log(e.message);
      process.exit(0);
    }
    console.error(`twzrd-cold-start: ${e instanceof Error ? e.message : e}`);
    console.error(USAGE);
    process.exit(2);
  }
  const { log, info } = console;
  console.log = (...a) => console.error(...a);
  console.info = (...a) => console.error(...a);
  let run;
  try {
    run = await runColdStart(args);
  } finally {
    console.log = log;
    console.info = info;
  }
  const { transcript, exitCode } = run;
  console.log(JSON.stringify(transcript, null, 2));
  console.error(
    `OK: cold-start ${transcript.allowlisted_count} allowlisted, signer_invocation_count=0, usdc_spent=0 — self-serve, not EXTERNAL_RUN`,
  );
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("twzrd-cold-start FAILED", e instanceof Error ? e.message : e);
  process.exit(1);
});
