#!/usr/bin/env node
/**
 * Pack smoke: clean build, npm pack, inspect the tarball, clean-install it into
 * an empty consumer, then import the public API and run the installed CLI.
 *
 * twzrd-log-verifier has never been on npm, so its first tarball is the one
 * every `npx -y twzrd-log-verifier` user gets. The publish workflow runs this
 * before `npm publish`; it fails on a tarball that misses a declared entry
 * point, ships the compiled tests, or installs a CLI that cannot run.
 *
 * The consumer install fetches the three runtime dependencies from the
 * registry. `selftest` itself is offline (in-memory log, throwaway keys).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "twzrd-log-verifier-pack-"));

function run(command, args, cwd, { allowFail = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 && !allowFail) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

const strip = (rel) => String(rel).replace(/^\.\//, "");

try {
  // The build script empties dist first, so no output of a deleted source file
  // can ride along, and marks the CLI executable.
  run("npm", ["run", "build"], root);
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], root).stdout,
  )[0];
  if (packed.name !== pkg.name || packed.version !== pkg.version) {
    throw new Error(`pack-smoke: packed ${packed.name}@${packed.version}, expected ${pkg.name}@${pkg.version}`);
  }
  const tarball = join(temp, packed.filename);

  // Inspect the tarball itself, not an install of it: npm install chmods bins
  // to 0755, which would hide a non-executable CLI that a workspace link or a
  // file: install then runs as exit 126.
  const listing = run("tar", ["-tzvf", tarball], temp).stdout.split("\n").filter(Boolean);
  const paths = new Set(listing.map((line) => line.trim().split(/\s+/).pop().replace(/^package\//, "")));

  const required = new Set(["package.json", "README.md", "LICENSE"]);
  for (const spec of Object.values(pkg.exports || {})) {
    for (const target of typeof spec === "string" ? [spec] : Object.values(spec)) required.add(strip(target));
  }
  for (const rel of Object.values(pkg.bin || {})) required.add(strip(rel));
  // The README promises the full source in the tarball: every src/*.ts and its build output.
  for (const name of readdirSync(join(root, "src")).filter((n) => n.endsWith(".ts"))) {
    required.add(`src/${name}`);
    required.add(`dist/src/${name.replace(/\.ts$/, ".js")}`);
    required.add(`dist/src/${name.replace(/\.ts$/, ".d.ts")}`);
  }
  const missing = [...required].filter((rel) => !paths.has(rel));
  if (missing.length) throw new Error(`pack-smoke: tarball is missing ${missing.join(", ")}`);

  const forbidden = [...paths].filter((rel) =>
    /^(dist\/test|test|scripts|node_modules)\//.test(rel) || /\.(tgz|env)$/.test(rel) || /(^|\/)\.env/.test(rel),
  );
  if (forbidden.length) throw new Error(`pack-smoke: tarball ships ${forbidden.join(", ")}`);

  for (const rel of Object.values(pkg.bin || {})) {
    const line = listing.find((l) => l.trimEnd().endsWith(`package/${strip(rel)}`));
    const mode = line.trim().split(/\s+/, 1)[0];
    if (mode.length < 4 || mode[3] !== "x") {
      throw new Error(`pack-smoke: ${strip(rel)} is not owner-executable in the tarball (${mode})`);
    }
    if (!readFileSync(join(root, strip(rel)), "utf8").startsWith("#!/usr/bin/env node\n")) {
      throw new Error(`pack-smoke: ${strip(rel)} has no node shebang`);
    }
  }

  const consumer = join(temp, "consumer");
  run("mkdir", ["-p", consumer], temp);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], consumer);

  // The names the README's Library section imports, plus the anchor surface 0.3.0 adds.
  writeFileSync(join(consumer, "smoke.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as lv from "twzrd-log-verifier";
// "exports" does not list ./package.json, so read the installed file directly.
const pkg = JSON.parse(readFileSync("node_modules/twzrd-log-verifier/package.json", "utf8"));
assert.equal(pkg.version, ${JSON.stringify(pkg.version)});
for (const name of [
  "verifyInclusion", "verifyConsistency", "verifySth", "verifyAnchor", "checkEquivocation",
  "merkleRoot", "inclusionProof", "consistencyProof",
  "validateLogKeyDirectory", "resolveLogKey", "currentSigningKey",
  "fetchLogDescriptor", "fetchSth", "fetchInclusionProof", "fetchConsistencyProof",
  "verifyReceiptInLog", "verifyLogInclusion", "resolveTrust", "createSthPinStore",
  "parseAnchorHeadData", "parseAnchorMemo", "anchorMatchesSth", "signSth",
]) {
  assert.equal(typeof lv[name], "function", name + " is not exported as a function");
}
assert.equal(lv.DEFAULT_STH_PUBKEY, "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS");
assert.equal(typeof lv.EVIDENCE_LEDGER_PROGRAM_ID, "string");
console.log("pack-smoke consumer: OK v" + pkg.version);
`);
  process.stdout.write(run("node", ["smoke.mjs"], consumer).stdout);

  const bin = join(consumer, "node_modules", ".bin", "twzrd-log-verifier");
  const help = run(bin, ["--help"], consumer);
  if (!help.stdout.includes("selftest")) throw new Error("pack-smoke: installed CLI --help does not list selftest");
  const selftest = run(bin, ["selftest"], consumer, { allowFail: true });
  if (selftest.status !== 0 || !/selftest: \d+ passed, 0 failed/.test(selftest.stdout)) {
    process.stderr.write(selftest.stdout + selftest.stderr);
    throw new Error(`pack-smoke: installed CLI selftest exited ${selftest.status}`);
  }
  console.log(`pack-smoke CLI: ${selftest.stdout.trim().split("\n").pop()}`);
  console.log(
    `pack-smoke: ALL PASSED (${pkg.name}@${pkg.version}, ${paths.size} files, ${packed.size} bytes packed)`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
