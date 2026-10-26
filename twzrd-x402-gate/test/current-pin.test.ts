/**
 * Current install and latest pins follow package.json. A line that only
 * records that a feature has existed since 0.12.4, or that 0.12.4 added it,
 * is not a current pin.
 *
 * Every `twzrd-x402-gate@<version>` in a doc this repository owns names
 * package.json's version, unless it records when a feature arrived ("since",
 * "ships from", "needs ... or later"). Dated records under docs/proofs,
 * docs/proposals, and their docs/archive copies keep the pins they were written with. Mirrors follow their
 * source instead and only have to sit between 0.12.5 and package.json's
 * version: SKILL.md and server/.well-known/mcp.json copy live intel
 * (check-gate-release-drift compares intel's advertised pin to this package),
 * and plugin-trustgate/README.md is that package's published text.
 * Run: npx tsx test/current-pin.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version: string };
const versionPattern = pkg.version.replace(/\./g, "\\.");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

const named = [
  join(repoRoot, "README.md"),
  join(repoRoot, "QUICKSTART.md"),
  join(repoRoot, "SKILL.md"),
  join(repoRoot, "AGENTS.md"),
  join(repoRoot, "plugin-trustgate/README.md"),
  join(repoRoot, "server/.well-known/mcp.json"),
  join(pkgRoot, "COMPATIBILITY.md"),
  join(pkgRoot, "README.md"),
  join(pkgRoot, "QUICKSTART.md"),
  ...walk(join(repoRoot, "docs")),
];

/** A feature-history line is not an instruction to install that version. */
function isFeatureHistory(line: string): boolean {
  return (
    /since 0\.12\.4/i.test(line) ||
    /added in 0\.12\.4/i.test(line) ||
    /0\.12\.4 added/i.test(line) ||
    /\bneeds\b[^\n]*0\.12\.4/.test(line) ||
    /from 0\.12\.4/.test(line) ||
    /0\.12\.4 or later/.test(line) ||
    /Pay-path behavior \(0\.12\.4\)/.test(line) ||
    /expectedAmount` \(0\.12\.4\)/.test(line)
  );
}

/** True when the line tells a reader the current package is still 0.12.4. */
function isStaleCurrentPin(line: string): boolean {
  if (isFeatureHistory(line)) return false;
  return (
    /twzrd-x402-gate@0\.12\.4\b/.test(line) ||
    /twzrd-x402-gate-0\.12\.4\.tgz/.test(line) ||
    /\*\*@0\.12\.4\*\*/.test(line) ||
    /latest` dist-tag: \*\*0\.12\.4\*\*/.test(line) ||
    /Treat 0\.12\.4 as the/.test(line) ||
    /This doc describes \*\*0\.12\.4\*\*/.test(line) ||
    /install pin is now 0\.12\.4\b/.test(line)
  );
}

const compat = readFileSync(join(pkgRoot, "COMPATIBILITY.md"), "utf8");
assert.match(
  compat,
  new RegExp(`${versionPattern} is the released identity`),
  "COMPATIBILITY.md must name the package version as the released identity",
);
assert.match(
  compat,
  new RegExp("`latest` dist-tag: \\*\\*" + versionPattern + "\\*\\*"),
  "COMPATIBILITY.md latest dist-tag must be the package version",
);
assert.match(
  compat,
  /`paying-client-fail-closed` is moved by hand after a publish \(it pointed at 0\.12\.0/,
  "paying-client-fail-closed stays described as 0.12.0 until that tag is moved",
);
assert.doesNotMatch(compat, /paying-client-fail-closed`[^\n]*\*\*0\.12\.5\*\*/);

const stale: string[] = [];
for (const file of named) {
  const rel = file.startsWith(repoRoot) ? file.slice(repoRoot.length + 1) : file;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (isStaleCurrentPin(line)) stale.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
}
assert.deepEqual(stale, [], "current install and latest pins must not stay on 0.12.4");

const historySamples = [
  "Optional `expectedAmount` (since 0.12.4) binds the challenge.",
  "Added in 0.12.4. 0.12.3 does not have this option.",
  "0.12.4 added an opt-in `expectedAmount` to `createBuyerFetch`.",
  "quote binding needs `twzrd-x402-gate@0.12.4`.",
];
for (const sample of historySamples) {
  assert.equal(isStaleCurrentPin(sample), false, sample);
}
assert.equal(isStaleCurrentPin("npm install twzrd-x402-gate@0.12.4 x402-solana@3.0.1"), true);
assert.equal(isStaleCurrentPin("`latest` dist-tag: **0.12.4**."), true);

const buyer = readFileSync(join(repoRoot, "docs/BUYER-FETCH.md"), "utf8");
assert.match(buyer, /since 0\.12\.4/);
const gateReadme = readFileSync(join(pkgRoot, "README.md"), "utf8");
assert.match(gateReadme, /Added in 0\.12\.4/);
assert.match(gateReadme, /since 0\.12\.4/);
assert.match(compat, /0\.12\.4 added an opt-in `expectedAmount`/);
const rootReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
assert.match(rootReadme, /needs `twzrd-x402-gate@0\.12\.4`/);
assert.match(readFileSync(join(repoRoot, "QUICKSTART.md"), "utf8"), /needs 0\.12\.4/);

/** Install pins in a mirrored file must sit between the 0.12.5 floor and the package version. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
function assertPinsInRange(file: string) {
  const pins = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !isFeatureHistory(line) && !/since `?twzrd-x402-gate@|at capture:/.test(line))
    .flatMap((line) => [...line.matchAll(/twzrd-x402-gate@(\d+\.\d+\.\d+)/g)].map((m) => m[1]));
  assert.ok(pins.length > 0, `${file} must name a twzrd-x402-gate install pin`);
  for (const v of pins) {
    assert.ok(
      compareSemver(v, "0.12.5") >= 0 && compareSemver(v, pkg.version) <= 0,
      `${file} pins twzrd-x402-gate@${v}, outside 0.12.5..${pkg.version}`,
    );
  }
}
assertPinsInRange(join(repoRoot, "README.md"));
assertPinsInRange(join(repoRoot, "server/.well-known/mcp.json"));
assertPinsInRange(join(repoRoot, "plugin-trustgate/README.md"));
assertPinsInRange(join(repoRoot, "SKILL.md"));

assert.match(rootReadme, new RegExp(`twzrd-x402-gate@${versionPattern}`));

const owned = [
  join(repoRoot, "README.md"),
  join(repoRoot, "QUICKSTART.md"),
  join(repoRoot, "AGENTS.md"),
  join(pkgRoot, "COMPATIBILITY.md"),
  join(pkgRoot, "README.md"),
  join(pkgRoot, "QUICKSTART.md"),
  ...walk(join(repoRoot, "docs")).filter(
    (f) => !/[\\/]docs[\\/](archive[\\/])?(proofs|proposals)[\\/]/.test(f),
  ),
];

/** A pin preceded by one of these records when a feature arrived, not what to install. */
const HISTORY_PREFIX = /(?:since|ships from|needs|added in|from) `?$/;

/** Every exact pin on a line that a reader would take as the version to install now. */
function currentPins(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/twzrd-x402-gate@(\d+\.\d+\.\d+)/g)) {
    const before = line.slice(Math.max(0, (m.index ?? 0) - 16), m.index);
    if (!HISTORY_PREFIX.test(before)) out.push(m[1]);
  }
  return out;
}

const behind: string[] = [];
for (const file of owned) {
  const rel = file.slice(repoRoot.length + 1);
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const v of currentPins(line)) {
        if (v !== pkg.version) behind.push(`${rel}:${i + 1}: ${v}`);
      }
    });
}
assert.deepEqual(behind, [], `current pins in owned docs must name ${pkg.version}`);

assert.deepEqual(currentPins("`createBuyerFetch` ships from `twzrd-x402-gate@0.12.3`; The current release is `twzrd-x402-gate@9.9.9`."), ["9.9.9"]);
assert.deepEqual(currentPins("is the front door (since `twzrd-x402-gate@0.12.3`); its"), []);
assert.deepEqual(currentPins("`expectedAmount` quote binding needs `twzrd-x402-gate@0.12.4` or later. Install"), []);
assert.deepEqual(currentPins("npm install twzrd-x402-gate@0.12.5 x402-solana@3.0.1"), ["0.12.5"]);
