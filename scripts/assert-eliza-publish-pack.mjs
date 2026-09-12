#!/usr/bin/env node
/**
 * Public-release contract for @wzrd_sol/eliza-plugin.
 *
 * Packs from eliza-plugin-source (or reads --from-staging / --from-tarball)
 * and refuses a tarball that is not the V7 publish surface.
 *
 *   node scripts/assert-eliza-publish-pack.mjs
 *   node scripts/assert-eliza-publish-pack.mjs --from-staging .npm/eliza-plugin-publish/staging
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packElizaPlugin, PUBLIC_NAME } from "./pack-eliza-plugin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_DIST = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/receipt-verify.js",
  "dist/receipt-verify.d.ts",
  "dist/actions/merchant-card.js",
  "dist/actions/intel-trust.js",
  "dist/actions/verify-receipt.js",
  "dist/actions/intel-preflight.js",
  "dist/paying-fetch.js",
];

const REQUIRED_INDEX_MARKERS = [
  "V7",
  "twzrd-receipt-verifier",
  "CURRENT_RECEIPT_PUBKEY",
  "freshnessFromVerify",
  "receipt-verify.js",
];

const FORBIDDEN_TARBALL_PREFIXES = ["src/", "test/", "node_modules/", "tsconfig"];

function parseArgs(argv) {
  const out = { fromStaging: null, fromTarball: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--from-staging" && argv[i + 1]) {
      out.fromStaging = resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--from-tarball" && argv[i + 1]) {
      out.fromTarball = resolve(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function listTarball(tarball) {
  const raw = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  return raw
    .split("\n")
    .map((line) => line.replace(/^package\//, "").replace(/\/$/, ""))
    .filter(Boolean);
}

export function evaluateElizaPublishPack({ pkg, indexSource, tarballEntries, stagingDir }) {
  const errors = [];
  if (pkg.name !== PUBLIC_NAME) errors.push(`name is ${pkg.name}, expected ${PUBLIC_NAME}`);
  if (pkg.private === true) errors.push("published package must not be private");
  if (pkg.publishConfig?.access !== "public") errors.push("publishConfig.access must be public");
  if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) errors.push("files must include dist");
  if (pkg.dependencies?.["twzrd-receipt-verifier"] !== "^1.4.0") {
    errors.push("dependencies.twzrd-receipt-verifier must be ^1.4.0");
  }
  if (!String(pkg.dependencies?.["twzrd-x402-gate"] ?? "").startsWith("^0.9.")) {
    errors.push("dependencies.twzrd-x402-gate must stay on the 0.9 line");
  }
  if (!String(pkg.dependencies?.["@wzrd_sol/sdk"] ?? "").startsWith("^0.4.")) {
    errors.push("dependencies.@wzrd_sol/sdk must stay on the 0.4 line");
  }
  if (!/V7/.test(pkg.description ?? "")) errors.push("description must name V7");
  if (stagingDir) {
    const readme = readFileSync(join(stagingDir, "README.md"), "utf8");
    if (!readme.includes("signed V7") && !readme.includes("V7 receipt")) {
      errors.push("README.md must describe the V7 receipt surface");
    }
    if (!readme.includes("synchronous")) {
      errors.push("README.md must document the sync verifyReceipt break vs 0.6.1");
    }
  }
  for (const marker of REQUIRED_INDEX_MARKERS) {
    if (!indexSource.includes(marker)) errors.push(`dist/index.js missing ${marker}`);
  }
  if (/export\s*\{[^}]*\bverifyReceipt\b[^}]*\}\s*from\s*['"]@wzrd_sol\/sdk['"]/.test(indexSource)) {
    errors.push("dist/index.js must not re-export SDK verifyReceipt");
  }
  for (const file of REQUIRED_DIST) {
    if (stagingDir && !existsSync(join(stagingDir, file))) errors.push(`missing ${file}`);
    if (tarballEntries && !tarballEntries.includes(file)) errors.push(`tarball missing ${file}`);
  }
  if (tarballEntries) {
    for (const entry of tarballEntries) {
      if (FORBIDDEN_TARBALL_PREFIXES.some((prefix) => entry === prefix || entry.startsWith(prefix))) {
        errors.push(`tarball must not include ${entry}`);
      }
    }
  }
  if (pkg.scripts?.build !== "echo 'eliza-plugin: built'") {
    errors.push("published scripts.build must stay a no-op so the mirror resync stays artifact-only");
  }
  return { ok: errors.length === 0, errors };
}

function extractTarball(tarball) {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-eliza-pack-"));
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  return join(dir, "package");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let stagingDir = args.fromStaging;
  let tarball = args.fromTarball;
  let cleanup = null;
  if (!stagingDir && !tarball) {
    const packed = packElizaPlugin({ outDir: join(ROOT, ".npm", "eliza-plugin-publish") });
    stagingDir = packed.stagingDir;
    tarball = packed.tarball;
  }
  if (tarball && !stagingDir) {
    stagingDir = extractTarball(tarball);
    cleanup = dirname(stagingDir);
  }
  const pkg = JSON.parse(readFileSync(join(stagingDir, "package.json"), "utf8"));
  const indexSource = readFileSync(join(stagingDir, "dist/index.js"), "utf8");
  const tarballEntries = tarball ? listTarball(tarball) : null;
  const result = evaluateElizaPublishPack({ pkg, indexSource, tarballEntries, stagingDir });
  if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  if (!result.ok) {
    console.error("Eliza publish pack: INCOMPLETE");
    for (const error of result.errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log(`Eliza publish pack: OK ${pkg.name}@${pkg.version}`);
}

main();
