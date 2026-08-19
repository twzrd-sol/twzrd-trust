/**
 * Release identity: package.json version is the single source of truth for
 * CLIENT_VERSION and the X-TWZRD-Client attribution header.
 *
 * Run: npx tsx test/version-identity.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLIENT_VERSION } from "../src/version.js";
import { resolveConfig } from "../src/config.js";
import { twzrdPreflight } from "../src/policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const require = createRequire(import.meta.url);

async function run() {
  const pkg = require("../package.json") as { name: string; version: string };
  assert.equal(pkg.name, "twzrd-x402-gate");
  assert.match(pkg.version, /^\d+\.\d+\.\d+/);

  // 1. Source export matches package.json
  assert.equal(
    CLIENT_VERSION,
    pkg.version,
    `CLIENT_VERSION (${CLIENT_VERSION}) must equal package.json version (${pkg.version})`,
  );

  // 2. package-lock root version must match (when lockfile is present)
  const lockPath = join(pkgRoot, "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };
    if (lock.version != null) {
      assert.equal(
        lock.version,
        pkg.version,
        `package-lock.json version (${lock.version}) must equal package.json (${pkg.version})`,
      );
    }
    const rootPkg = lock.packages?.[""];
    if (rootPkg?.version != null) {
      assert.equal(
        rootPkg.version,
        pkg.version,
        `package-lock packages[""].version (${rootPkg.version}) must equal package.json (${pkg.version})`,
      );
    }
  }

  // 3. Built dist (when present) resolves the same version
  const distVersionPath = join(pkgRoot, "dist", "version.js");
  if (existsSync(distVersionPath)) {
    const distMod = await import(distVersionPath);
    assert.equal(
      distMod.CLIENT_VERSION,
      pkg.version,
      `dist/version.js CLIENT_VERSION (${distMod.CLIENT_VERSION}) must equal package.json (${pkg.version})`,
    );
  }

  // 4. Live preflight header uses the same version string
  let seenClient: string | null = null;
  const fetchSpy = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    const h = new Headers(init?.headers);
    seenClient = h.get("X-TWZRD-Client") ?? h.get("x-twzrd-client");
    return new Response(
      JSON.stringify({
        readiness_card: {
          decision: "allow",
          trust_score: 90,
          can_spend: true,
          seller_wallet: "SELLER",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  await twzrdPreflight(
    {
      resource_name: "version-identity-test",
      seller_wallet: "SELLER",
    },
    resolveConfig({
      fetch: fetchSpy,
      attribution: { integration: "version-identity-test", runId: "run-1" },
    }),
  );

  assert.equal(
    seenClient,
    `twzrd-x402-gate/${pkg.version}`,
    `X-TWZRD-Client header must be twzrd-x402-gate/${pkg.version}, got ${seenClient}`,
  );

  console.log(`version-identity.test.ts: ALL PASSED (v${pkg.version})`);
}

run().catch((e) => {
  console.error("version-identity.test.ts FAILED:", e);
  process.exit(1);
});
