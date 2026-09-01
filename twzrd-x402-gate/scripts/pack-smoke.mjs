#!/usr/bin/env node
/**
 * Pack smoke: build, npm pack, clean-install, then verify public exports and
 * the version used in the preflight attribution header.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "twzrd-x402-gate-pack-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

try {
  run("npx", ["--yes", "tsc"], root);
  run("npm", ["pack", "--json", "--ignore-scripts"], root);
  const tarball = readdirSync(root).find((name) => name.endsWith(".tgz") && name.includes(pkg.version));
  if (!tarball) throw new Error(`npm pack produced no tarball for ${pkg.name}@${pkg.version}`);

  const consumer = join(temp, "consumer");
  run("mkdir", ["-p", consumer], temp);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  copyFileSync(join(root, tarball), join(consumer, tarball));
  run("npm", ["install", `./${tarball}`, "--ignore-scripts", "--no-audit", "--no-fund"], consumer);

  writeFileSync(join(consumer, "smoke.mjs"), `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as gate from "twzrd-x402-gate";
const require = createRequire(import.meta.url);
const pkg = require("twzrd-x402-gate/package.json");
assert.equal(typeof gate.twzrd.safeFetch, "function");
assert.equal(typeof gate.spendControlSafeFetch, "function");
assert.equal(typeof gate.assertIntentApproved, "function");
assert.equal(typeof gate.exportEvidenceBundle, "function");
assert.equal(typeof gate.listDirectoryCallables, "function");
assert.equal(gate.EVIDENCE_BUNDLE_SCHEMA, "twzrd.evidence_bundle.v1");
assert.equal(gate.CLIENT_VERSION, pkg.version);
let seen = null;
await gate.twzrdPreflight({ resource_name: "pack-smoke", seller_wallet: "SELLER" }, gate.resolveConfig({
  attribution: { integration: "pack-smoke", runId: "1" },
  fetch: async (_url, init) => {
    seen = new Headers(init?.headers).get("X-TWZRD-Client");
    return new Response(JSON.stringify({ readiness_card: { decision: "allow", trust_score: 90 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  },
}));
assert.equal(seen, "twzrd-x402-gate/" + pkg.version);
console.log("pack-smoke consumer: OK v" + pkg.version);
`);
  const smoke = run("node", ["smoke.mjs"], consumer);
  process.stdout.write(smoke.stdout);
  console.log(`pack-smoke: ALL PASSED (${pkg.name}@${pkg.version})`);
} finally {
  for (const entry of readdirSync(root)) {
    if (entry.endsWith(".tgz")) rmSync(join(root, entry), { force: true });
  }
  rmSync(temp, { recursive: true, force: true });
}
