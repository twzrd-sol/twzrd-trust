#!/usr/bin/env node
/**
 * Public-release surface contract for twzrd-x402-gate.
 *
 * npm 0.10.0 shipped 2026-09-02 without PayKit (#69, 2026-09-03) and without
 * ./evidence-verify. Live docs still pin 0.9.3. This script is the lock so the
 * next publish cannot claim "latest" while missing the reviewed seats.
 *
 *   node scripts/assert-packed-surface.mjs --public-release --from-package
 *
 * Exits 1 when the coordinated surface is incomplete. Do not put this on the
 * default `npm test` path until the monorepo fork carries PayKit; put it on
 * the publish workflow so a button-press cannot ship another partial tarball.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_RELEASE_SURFACE = {
  subpaths: [
    "./safe-fetch",
    "./unsafe",
    "./evidence-verify",
    "./cloudflare-base",
  ],
  named: [
    "createTwzrdPayKitBeforePaymentHook",
    "createTwzrdBeforePaymentHook",
    "installTwzrdX402ClientHook",
    "CLIENT_VERSION",
  ],
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

function namedExportRe(name) {
  return new RegExp(
    `(?:export\\s*\\{[^}]*\\b${name}\\b|export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\b)`,
  );
}

export function evaluatePackedSurface({ exportMap, indexSource }) {
  const missingSubpaths = PUBLIC_RELEASE_SURFACE.subpaths.filter(
    (sub) => exportMap == null || exportMap[sub] == null,
  );
  const missingNamed = PUBLIC_RELEASE_SURFACE.named.filter(
    (name) => !namedExportRe(name).test(indexSource || ""),
  );
  return {
    ok: missingSubpaths.length === 0 && missingNamed.length === 0,
    missingSubpaths,
    missingNamed,
  };
}

export function evaluateDeclaredExportSources({ exportMap, pkgRoot: root }) {
  const missingFiles = [];
  for (const [sub, spec] of Object.entries(exportMap || {})) {
    if (sub === "." || sub === "./package.json") continue;
    const importPath = typeof spec === "string" ? spec : spec?.import;
    if (!importPath) {
      missingFiles.push(`${sub} (no import target)`);
      continue;
    }
    const distFile = join(root, importPath);
    const srcGuess = join(
      root,
      "src",
      `${sub.replace(/^\.\//, "")}.ts`,
    );
    if (!existsSync(distFile) && !existsSync(srcGuess)) {
      missingFiles.push(`${sub} -> ${importPath}`);
    }
  }
  return { ok: missingFiles.length === 0, missingFiles };
}

export function loadLocalPackageSurface(root = pkgRoot) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const indexPath = join(root, "src", "index.ts");
  return {
    version: pkg.version,
    exportMap: pkg.exports || {},
    indexSource: readFileSync(indexPath, "utf8"),
  };
}

function printReport(label, result) {
  if (result.ok) {
    console.log(`${label}: OK`);
    return;
  }
  console.error(`${label}: INCOMPLETE`);
  for (const sub of result.missingSubpaths || []) {
    console.error(`  missing export ${sub}`);
  }
  for (const name of result.missingNamed || []) {
    console.error(`  missing named export ${name}`);
  }
  for (const file of result.missingFiles || []) {
    console.error(`  missing file ${file}`);
  }
}

function main(argv) {
  const publicRelease = argv.includes("--public-release");
  const fromPackage = argv.includes("--from-package");
  if (!fromPackage) {
    console.error("usage: node scripts/assert-packed-surface.mjs --public-release --from-package");
    process.exit(2);
  }
  const local = loadLocalPackageSurface();
  const declared = evaluateDeclaredExportSources({
    exportMap: local.exportMap,
    pkgRoot,
  });
  printReport("declared-export-sources", declared);
  if (publicRelease) {
    const surface = evaluatePackedSurface({
      exportMap: local.exportMap,
      indexSource: local.indexSource,
    });
    printReport(`public-release ${local.version}`, surface);
    if (!surface.ok || !declared.ok) process.exit(1);
    return;
  }
  if (!declared.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
