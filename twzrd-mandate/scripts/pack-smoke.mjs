#!/usr/bin/env node
/**
 * Pack smoke: clean build, npm pack, inspect the tarball, clean-install it
 * into an empty consumer, then import the public API and run the installed
 * CLI the way `npx @twzrd1111/mandate` runs it.
 *
 * @twzrd1111/mandate has never been on npm, so its first tarball is the one
 * every `npx @twzrd1111/mandate init` user gets. The publish workflow runs
 * this before `npm publish`; it fails on a tarball that misses a declared
 * entry point or the receipt fixtures the breaker proof replays, ships the
 * tests or a key file, or installs a CLI that cannot run.
 *
 * The consumer install fetches the three runtime dependencies from the
 * registry. Everything it then runs is offline: `verify-breakers` uses a
 * loopback world and no wallet.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "twzrd-mandate-pack-"));

function run(command, args, cwd, { allowFail = false, env } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
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
  const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], root).stdout)[0];
  if (packed.name !== pkg.name || packed.version !== pkg.version) {
    throw new Error(`pack-smoke: packed ${packed.name}@${packed.version}, expected ${pkg.name}@${pkg.version}`);
  }
  const tarball = join(temp, packed.filename);

  // Inspect the tarball itself, not an install of it: npm install chmods bins
  // to 0755, which would hide a non-executable CLI.
  const listing = run("tar", ["-tzvf", tarball], temp).stdout.split("\n").filter(Boolean);
  const paths = new Set(listing.map((line) => line.trim().split(/\s+/).pop().replace(/^package\//, "")));

  const required = new Set(["package.json", "README.md", "LICENSE", "SPEC.md", "CHANGELOG.md"]);
  for (const spec of Object.values(pkg.exports || {})) {
    for (const target of typeof spec === "string" ? [spec] : Object.values(spec)) required.add(strip(target));
  }
  for (const rel of Object.values(pkg.bin || {})) required.add(strip(rel));
  for (const name of readdirSync(join(root, "src")).filter((n) => n.endsWith(".ts"))) {
    required.add(`dist/${name.replace(/\.ts$/, ".js")}`);
    required.add(`dist/${name.replace(/\.ts$/, ".d.ts")}`);
  }
  // The loopback world replays these; without them verify-breakers cannot run.
  for (const name of readdirSync(join(root, "fixtures"))) required.add(`fixtures/${name}`);
  const missing = [...required].filter((rel) => !paths.has(rel));
  if (missing.length) throw new Error(`pack-smoke: tarball is missing ${missing.join(", ")}`);

  const forbidden = [...paths].filter(
    (rel) =>
      /^(test|scripts|src|node_modules)\//.test(rel) ||
      /\.(tgz|env|token|lock)$/.test(rel) ||
      /(^|\/)\.env/.test(rel) ||
      /(^|\/)(agent|operator|mandate)\.json$/.test(rel) ||
      /(^|\/)\.twzrd-mandate\//.test(rel),
  );
  if (forbidden.length) throw new Error(`pack-smoke: tarball ships ${forbidden.join(", ")}`);

  for (const rel of new Set(Object.values(pkg.bin || {}))) {
    const line = listing.find((l) => l.trimEnd().endsWith(`package/${strip(rel)}`));
    const mode = line.trim().split(/\s+/, 1)[0];
    if (mode.length < 4 || mode[3] !== "x") {
      throw new Error(`pack-smoke: ${strip(rel)} is not owner-executable in the tarball (${mode})`);
    }
    if (!readFileSync(join(root, strip(rel)), "utf8").startsWith("#!/usr/bin/env node\n")) {
      throw new Error(`pack-smoke: ${strip(rel)} has no node shebang`);
    }
  }

  // A clean consumer: nothing but this tarball and what it depends on.
  const consumer = join(temp, "consumer");
  run("mkdir", ["-p", consumer], temp);
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ name: "mandate-pack-consumer", private: true, type: "module" }, null, 2)}\n`);
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], consumer);

  // The gate and the guard read TWZRD_* and KILLSWITCH_* from the environment; the smoke must not inherit them.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TWZRD_|KILLSWITCH_)/.test(key)));

  writeFileSync(
    join(consumer, "api.mjs"),
    [
      `import * as api from "${pkg.name}";`,
      `import { createRequire } from "node:module";`,
      `const need = ["issueMandate", "verifyMandate", "createMandateRuntime", "startSidecar", "createMcpGateway", "emitHeartbeat", "verifyHeartbeat", "verifyBreakers", "VERSION"];`,
      `const absent = need.filter((name) => api[name] === undefined);`,
      `if (absent.length) throw new Error("missing exports: " + absent.join(", "));`,
      `if (api.VERSION !== ${JSON.stringify(pkg.version)}) throw new Error("VERSION is " + api.VERSION);`,
      `const schema = createRequire(import.meta.url)("${pkg.name}/schema");`,
      `if (schema.title === undefined || schema.$id.includes("#")) throw new Error("schema export is wrong");`,
      `const key = api.keyFromSeed(new Uint8Array(32).fill(7));`,
      `const mandate = api.issueMandate({ issuerMode: "self-mandated", issuerKey: key, maxPerCallUsd: "0.10", dailyCeilingUsd: "2.00", allowedChains: ["solana"], minTrustScore: 75, allowedTools: ["http:intel.twzrd.xyz"], killswitchDir: ".twzrd-mandate", lifetimeMs: 3600000 });`,
      `if (!api.verifyMandate(mandate, { heldAgentKey: key.publicKey }).ok) throw new Error("a fresh mandate did not verify");`,
      `console.log("api ok");`,
    ].join("\n"),
  );
  run("node", ["api.mjs"], consumer, { env });

  const bin = join(consumer, "node_modules", ".bin", "mandate");
  if (!existsSync(bin)) throw new Error("pack-smoke: the install created no `mandate` bin");
  const version = run(bin, ["--version"], consumer, { env }).stdout.trim();
  if (version !== pkg.version) throw new Error(`pack-smoke: mandate --version printed ${version}`);

  // The quickstart, as a user types it.
  run(bin, ["init", "--daily", "5.00", "--min-trust", "75"], consumer, { env });
  for (const file of ["mandate.json", "operator.json", "agent.json"]) {
    if (!existsSync(join(consumer, file))) throw new Error(`pack-smoke: init did not write ${file}`);
  }
  if ((statSync(join(consumer, "agent.json")).mode & 0o077) !== 0) throw new Error("pack-smoke: agent.json is readable by others");
  const issued = JSON.parse(readFileSync(join(consumer, "mandate.json"), "utf8"));
  run(bin, ["verify", "--trust-issuer", issued.issuer], consumer, { env });
  run(bin, ["self-issue", "--agent-key", "./agent2.json", "--daily", "2.00", "--out", "self.json"], consumer, { env });
  run(bin, ["verify", "self.json", "--agent-key", "./agent2.json"], consumer, { env });

  const breakers = JSON.parse(run(bin, ["verify-breakers", "--json"], consumer, { env }).stdout);
  if (breakers.ok !== true || breakers.layersProven.length !== 6 || breakers.totalSignatures !== 0) {
    throw new Error(`pack-smoke: verify-breakers from the installed package failed: ${JSON.stringify(breakers.cases.filter((c) => !c.passed))}`);
  }

  console.log(
    `pack-smoke OK: ${packed.filename} (${packed.files.length} files, ${packed.size} bytes packed); api import, init, self-issue, verify and verify-breakers (${breakers.cases.length} cases, 0 signatures) ran from a clean install`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
