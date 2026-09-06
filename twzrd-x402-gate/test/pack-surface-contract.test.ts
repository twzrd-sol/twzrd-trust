/**
 * Pins the 2026-09-02 npm 0.10.0 miss: tarball lacked PayKit and
 * ./evidence-verify. The checker must fail that surface and pass a complete one.
 *
 * Run: npx tsx test/pack-surface-contract.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateDeclaredExportSources,
  evaluatePackedSurface,
  loadLocalPackageSurface,
} from "../scripts/assert-packed-surface.mjs"; // allowJs: publish-gate script, not a shipped export

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

// Exact export map of registry.npmjs.org/twzrd-x402-gate/0.10.0 (published 2026-09-02).
const NPM_0_10_0_EXPORTS = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  "./safe-fetch": { types: "./dist/safe-fetch.d.ts", import: "./dist/safe-fetch.js" },
  "./unsafe": { types: "./dist/unsafe.d.ts", import: "./dist/unsafe.js" },
  "./package.json": "./package.json",
};

function run() {
  const npm010 = evaluatePackedSurface({
    exportMap: NPM_0_10_0_EXPORTS,
    indexSource: [
      "export { CLIENT_VERSION } from \"./version.js\";",
      "export { createTwzrdBeforePaymentHook, installTwzrdX402ClientHook } from \"./x402-client-hook.js\";",
    ].join("\n"),
  });
  assert.equal(npm010.ok, false, "published 0.10.0 must fail the public-release contract");
  assert.ok(npm010.missingSubpaths.includes("./evidence-verify"));
  assert.ok(npm010.missingSubpaths.includes("./cloudflare-base"));
  assert.ok(npm010.missingNamed.includes("createTwzrdPayKitBeforePaymentHook"));

  const complete = evaluatePackedSurface({
    exportMap: {
      ...NPM_0_10_0_EXPORTS,
      "./evidence-verify": {
        types: "./dist/evidence-verify.d.ts",
        import: "./dist/evidence-verify.js",
      },
      "./cloudflare-base": {
        types: "./dist/cloudflare-base.d.ts",
        import: "./dist/cloudflare-base.js",
      },
    },
    indexSource: [
      "export { CLIENT_VERSION } from \"./version.js\";",
      "export {",
      "  createTwzrdPayKitBeforePaymentHook,",
      "  createTwzrdBeforePaymentHook,",
      "  installTwzrdX402ClientHook,",
      "} from \"./x402-client-hook.js\";",
    ].join("\n"),
  });
  assert.equal(complete.ok, true, JSON.stringify(complete));

  const local = loadLocalPackageSurface(pkgRoot);
  const declared = evaluateDeclaredExportSources({
    exportMap: local.exportMap,
    pkgRoot,
  });
  assert.equal(declared.ok, true, JSON.stringify(declared));
  assert.ok(local.exportMap["./cloudflare-base"], "monorepo fork must keep ./cloudflare-base");
  const localPublic = evaluatePackedSurface({
    exportMap: local.exportMap,
    indexSource: local.indexSource,
  });
  assert.equal(
    localPublic.ok,
    true,
    "twzrd-trust release surface must be complete: exports PayKit, unsafe, evidence-verify, cloudflare-base",
  );

  console.log("pack-surface-contract.test.ts: ALL PASSED");
}

run();
