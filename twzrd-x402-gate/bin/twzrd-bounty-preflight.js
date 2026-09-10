#!/usr/bin/env node
/**
 * Worker preflight for agent bounty boards — zero spend.
 *
 * Before a bounty-hunting agent pays an attempt fee or stakes collateral, read the
 * board, read the paid door's unpaid 402 for its payTo, run the free TWZRD gate on
 * that payTo, and decide per open row: gate block/wash, payout rail, money at risk
 * vs ceiling, and YOUR declared win probability vs break-even. Prints one JSON
 * report (schema twzrd.bounty_preflight.v1) and exits 1 on refuse.
 *
 * Nothing here signs or spends. The board's approval rate is context only; it is
 * never substituted for --assumed-win-prob. Self-serve transcript, not adoption proof.
 *
 * Usage (after npm run build, or from the published package):
 *   node node_modules/twzrd-x402-gate/bin/twzrd-bounty-preflight.js \
 *     --board https://deskcrew.io/api/arena/contests --assumed-win-prob 0.2
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function loadCli() {
  const dist = join(pkgRoot, "dist", "bounty-preflight-cli.js");
  if (existsSync(dist)) return import(pathToFileURL(dist).href);
  console.error("twzrd-bounty-preflight: run `npm run build` in twzrd-x402-gate or install the published package");
  process.exit(2);
}

async function main() {
  const { parseArgs, runBountyPreflight, USAGE } = await loadCli();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`twzrd-bounty-preflight: ${e instanceof Error ? e.message : e}`);
    console.error(USAGE);
    process.exit(2);
  }
  // The gate library narrates (e.g. unsupported_network_seen) on stdout; keep stdout a
  // single JSON document by routing that narration to stderr for the duration of the run.
  const { log, info } = console;
  console.log = (...a) => console.error(...a);
  console.info = (...a) => console.error(...a);
  let run;
  try {
    run = await runBountyPreflight(args);
  } finally {
    console.log = log;
    console.info = info;
  }
  const { report, exitCode } = run;
  console.log(JSON.stringify(report, null, 2));
  if (exitCode) console.error(`REFUSE: ${report.refuse_reasons.join(", ")} (nothing signed, nothing spent)`);
  else console.error("OK: proceed — self-serve transcript, not external partner proof; nothing signed, nothing spent");
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("twzrd-bounty-preflight FAILED", e instanceof Error ? e.message : e);
  process.exit(1);
});
