#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const receiptPatterns = [
  /\bV5\b/g,
  /\bV6\b/g,
  /\bV7\b/g,
  /TWZRD:AO_REPUTATION_RECEIPT_V[567]/g,
  /twzrd_receipt/g,
  /recheck_after_unix/g,
  /staleness_days/g,
  /score_decay_model/g,
];
const requiredBaselineFiles = [
  "src/actions/intel-trust.ts",
  "src/actions/verify-receipt.ts",
  "test/plugin-registration.intel.ts",
];

async function listFiles(root, predicate = () => true) {
  const out = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && predicate(path)) {
        out.push(relative(root, path));
      }
    }
  }
  await walk(root);
  return out.sort();
}

function sourcePathForDist(distFile) {
  const tsPath = distFile
    .replace(/\.d\.ts$/, ".ts")
    .replace(/\.js$/, ".ts");
  if (tsPath.startsWith("actions/")) return tsPath.replace(/^actions\//, "src/actions/");
  if (tsPath.startsWith("test/")) return tsPath;
  return `src/${tsPath}`;
}

async function grepFiles(root, files) {
  const hits = [];
  for (const file of files) {
    const text = await readFile(join(root, file), "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of receiptPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) hits.push({ file, line: index + 1, text: line.trim() });
      }
    });
  }
  return hits;
}

const baselineDir = await mkdtemp(join(tmpdir(), "twzrd-eliza-migration-inventory-"));
try {
  await execFileAsync(process.execPath, [
    "scripts/extract-eliza-source-baseline.mjs",
    "--target",
    baselineDir,
  ]);

  const baselineFiles = await listFiles(baselineDir, (file) => /\.[jt]s$/.test(file));
  const distFiles = await listFiles("eliza-plugin/dist", (file) => /\.(js|d\.ts)$/.test(file));
  const baselineSet = new Set(baselineFiles);

  const currentDistWithoutBaselineSource = distFiles
    .map((file) => ({ dist: file, expectedSource: sourcePathForDist(file) }))
    .filter(({ expectedSource }) => !baselineSet.has(expectedSource));
  const receiptHits = await grepFiles("eliza-plugin/dist", distFiles.filter((file) => file.endsWith(".js")));
  const missingRequired = requiredBaselineFiles.filter((file) => !baselineSet.has(file));

  if (missingRequired.length > 0) {
    console.error(`Missing required historical Eliza source files: ${missingRequired.join(", ")}`);
    process.exit(1);
  }

  const inventory = {
    baselineSourceFiles: baselineFiles.length,
    currentDistFiles: distFiles.length,
    currentDistWithoutBaselineSource,
    receiptMigrationHits: receiptHits,
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(inventory, null, 2));
  } else {
    console.log("Eliza migration inventory");
    console.log(`baseline_source_files=${inventory.baselineSourceFiles}`);
    console.log(`current_dist_files=${inventory.currentDistFiles}`);
    console.log(`dist_files_without_baseline_source=${currentDistWithoutBaselineSource.length}`);
    for (const item of currentDistWithoutBaselineSource) {
      console.log(`- ${item.dist} expects ${item.expectedSource}`);
    }
    console.log(`receipt_migration_hits=${receiptHits.length}`);
  }
} finally {
  await rm(baselineDir, { recursive: true, force: true });
}
