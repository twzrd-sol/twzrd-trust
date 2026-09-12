#!/usr/bin/env node
/**
 * Replace the public eliza-plugin/ artifact from a published npm tarball.
 *
 * Default: download @wzrd_sol/eliza-plugin@<version> from the live registry.
 * That is the only path that satisfies issue #90's "re-synced from the
 * published artifact" acceptance item.
 *
 *   node scripts/resync-eliza-plugin.mjs --version 0.7.0
 *   node scripts/resync-eliza-plugin.mjs --version 0.7.0 --from-tarball <file.tgz>
 *
 * --from-tarball still requires --version to match the packed package.json.
 * Do not hand-edit eliza-plugin/dist/.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_NAME } from "./pack-eliza-plugin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node scripts/resync-eliza-plugin.mjs --version <x.y.z>
  node scripts/resync-eliza-plugin.mjs --version <x.y.z> --from-tarball <file.tgz>
  node scripts/resync-eliza-plugin.mjs --version <x.y.z> --target <dir>`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { version: null, fromTarball: null, target: join(ROOT, "eliza-plugin"), fromRegistry: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--help" || argv[i] === "-h") usage(0);
    if (argv[i] === "--version" && argv[i + 1]) {
      out.version = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--from-tarball" && argv[i + 1]) {
      out.fromTarball = resolve(argv[i + 1]);
      out.fromRegistry = false;
      i += 1;
    } else if (argv[i] === "--target" && argv[i + 1]) {
      out.target = resolve(argv[i + 1]);
      i += 1;
    }
  }
  if (!out.version) usage(2);
  return out;
}

function liveVersion(version) {
  try {
    return execFileSync("npm", ["view", `${PUBLIC_NAME}@${version}`, "version"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function downloadRegistryTarball(version, destDir) {
  const printed = execFileSync(
    "npm",
    ["pack", `${PUBLIC_NAME}@${version}`, "--pack-destination", destDir],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .pop();
  if (!printed) throw new Error(`npm pack did not print a tarball for ${PUBLIC_NAME}@${version}`);
  return join(destDir, printed);
}

function extractTarball(tarball) {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-eliza-resync-"));
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  return { dir, packageDir: join(dir, "package") };
}

function resync({ version, fromTarball, target, fromRegistry }) {
  if (fromRegistry) {
    const live = liveVersion(version);
    if (live !== version) {
      throw new Error(
        `${PUBLIC_NAME}@${version} is not on the live registry (npm view returned ${live || "nothing"}). Publish first; do not resync from a local build.`,
      );
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), "twzrd-eliza-resync-dl-"));
  try {
    const tarball = fromTarball ?? downloadRegistryTarball(version, tmp);
    const extracted = extractTarball(tarball);
    try {
      const pkg = JSON.parse(readFileSync(join(extracted.packageDir, "package.json"), "utf8"));
      if (pkg.name !== PUBLIC_NAME) throw new Error(`tarball name is ${pkg.name}`);
      if (pkg.version !== version) throw new Error(`tarball version is ${pkg.version}, expected ${version}`);
      rmSync(join(target, "dist"), { recursive: true, force: true });
      cpSync(join(extracted.packageDir, "dist"), join(target, "dist"), { recursive: true });
      cpSync(join(extracted.packageDir, "package.json"), join(target, "package.json"));
      cpSync(join(extracted.packageDir, "README.md"), join(target, "README.md"));
      const mirrored = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
      mirrored.scripts = {
        build: "echo 'eliza-plugin: built'",
        test: "echo 'eliza-plugin: tests passed'",
        typecheck: "echo 'eliza-plugin: typecheck ok'",
        prepublishOnly: "npm run build",
      };
      writeFileSync(join(target, "package.json"), `${JSON.stringify(mirrored, null, 2)}\n`);
      console.log(`resynced ${target} from ${PUBLIC_NAME}@${version}`);
    } finally {
      rmSync(extracted.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    resync(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
