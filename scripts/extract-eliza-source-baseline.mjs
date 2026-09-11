#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const BASELINE_COMMIT = "98e4b78779980c4b5b9581b78dfe292eda82aad5";
const SOURCE_ROOT = "eliza-plugin";
const FILES = [
  "README.md",
  "package-lock.json",
  "package.json",
  "src/actions/claim.ts",
  "src/actions/earn.ts",
  "src/actions/infer.ts",
  "src/actions/intel-preflight.ts",
  "src/actions/intel-trust.ts",
  "src/actions/report.ts",
  "src/actions/rewards.ts",
  "src/actions/verify-receipt.ts",
  "src/client-factory.ts",
  "src/client.ts",
  "src/index.ts",
  "src/intel-helpers.ts",
  "src/paying-fetch.ts",
  "test/earn-e2e.ts",
  "test/plugin-registration.intel.ts",
  "tsconfig.json",
  "tsconfig.test.json",
];

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node scripts/extract-eliza-source-baseline.mjs --list
  node scripts/extract-eliza-source-baseline.mjs --target <dir> [--force]

Extracts the historical Eliza plugin source baseline from ${BASELINE_COMMIT}:${SOURCE_ROOT}.
The output is for V7 migration prep only; it does not make eliza-plugin/ buildable in this mirror.`);
  process.exit(exitCode);
}

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const force = args.includes("--force");
const targetIndex = args.indexOf("--target");
const target = targetIndex === -1 ? null : args[targetIndex + 1];

if (args.includes("--help") || args.includes("-h")) usage(0);
if (listOnly) {
  for (const file of FILES) console.log(file);
  process.exit(0);
}
if (!target || target.startsWith("--")) usage(1);

function ensureBaselineCommit() {
  try {
    execFileSync("git", ["cat-file", "-e", `${BASELINE_COMMIT}^{commit}`], { stdio: "ignore" });
    return;
  } catch {
    execFileSync("git", ["fetch", "--depth=1", "origin", BASELINE_COMMIT], { stdio: "inherit" });
  }
}

const outDir = resolve(target);
if (existsSync(outDir)) {
  const entries = readdirSync(outDir);
  if (entries.length > 0 && !force) {
    console.error(`Refusing to write into non-empty target: ${outDir}`);
    console.error("Pass --force to remove and recreate that exact directory.");
    process.exit(1);
  }
  if (entries.length > 0) rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

ensureBaselineCommit();
for (const file of FILES) {
  const bytes = execFileSync("git", ["show", `${BASELINE_COMMIT}:${SOURCE_ROOT}/${file}`]);
  const dest = resolve(outDir, file);
  if (!dest.startsWith(`${outDir}/`)) {
    throw new Error(`Refusing unexpected output path: ${dest}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
}

console.log(`Extracted ${FILES.length} files from ${BASELINE_COMMIT}:${SOURCE_ROOT} to ${outDir}`);
