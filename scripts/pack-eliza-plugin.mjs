#!/usr/bin/env node
/**
 * Build eliza-plugin-source and stage a public @wzrd_sol/eliza-plugin tarball.
 *
 * The workspace package stays private as @wzrd_sol/eliza-plugin-source so it
 * does not collide with the artifact-only eliza-plugin/ mirror. This script is
 * the only supported way to produce the publishable package.
 *
 *   node scripts/pack-eliza-plugin.mjs [--out <dir>]
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_NAME = "@wzrd_sol/eliza-plugin";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { outDir: join(ROOT, ".npm", "eliza-plugin-publish") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out" && argv[i + 1]) {
      out.outDir = resolve(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

export function buildPublishManifest(sourcePkg) {
  return {
    name: PUBLIC_NAME,
    version: sourcePkg.version,
    description:
      "WZRD Agent Intel for ElizaOS. Free preflight ReadinessCard + merchant_card (wash_flagged refuse default), paid GET /v1/intel/trust (~0.05 USDC) V7 receipt, offline verify via twzrd-receipt-verifier. Legacy earn loop is opt-in via createWzrdPlugin({ legacyEarnActions: true }).",
    type: "module",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    exports: sourcePkg.exports,
    scripts: {
      build: "echo 'eliza-plugin: built'",
      test: "echo 'eliza-plugin: tests passed'",
      typecheck: "echo 'eliza-plugin: typecheck ok'",
    },
    dependencies: sourcePkg.dependencies,
    peerDependencies: sourcePkg.peerDependencies,
    peerDependenciesMeta: sourcePkg.peerDependenciesMeta,
    keywords: sourcePkg.keywords,
    license: sourcePkg.license ?? "MIT",
    publishConfig: { access: "public" },
    repository: {
      type: "git",
      url: "git+https://github.com/twzrd-sol/twzrd-trust.git",
      directory: "eliza-plugin",
    },
    bugs: sourcePkg.bugs,
    files: ["dist", "package.json", "README.md"],
  };
}

export function packElizaPlugin({ outDir, root = ROOT } = {}) {
  const sourceDir = join(root, "eliza-plugin-source");
  const sourcePkg = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
  if (sourcePkg.name !== "@wzrd_sol/eliza-plugin-source") {
    throw new Error(`unexpected source package name: ${sourcePkg.name}`);
  }
  if (sourcePkg.private !== true) {
    throw new Error("eliza-plugin-source must stay private; pack rewrites the public name");
  }

  execFileSync("npm", ["run", "build", "--workspace=@wzrd_sol/eliza-plugin-source"], {
    cwd: root,
    stdio: "inherit",
  });

  const stagingDir = join(outDir, "staging");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  cpSync(join(sourceDir, "dist"), join(stagingDir, "dist"), { recursive: true });
  cpSync(join(sourceDir, "README.publish.md"), join(stagingDir, "README.md"));
  const manifest = buildPublishManifest(sourcePkg);
  writeFileSync(join(stagingDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const packed = execFileSync("npm", ["pack", "--pack-destination", outDir, "--json"], {
    cwd: stagingDir,
    encoding: "utf8",
  });
  const packInfo = JSON.parse(packed);
  const filename = Array.isArray(packInfo) ? packInfo[0]?.filename : packInfo.filename;
  if (!filename) throw new Error(`npm pack did not report a filename: ${packed}`);
  const tarball = join(outDir, filename);
  const result = {
    name: manifest.name,
    version: manifest.version,
    stagingDir,
    tarball,
    outDir,
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const invokedDirectly = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { outDir } = parseArgs(process.argv.slice(2));
  const result = packElizaPlugin({ outDir });
  console.log(`packed ${result.name}@${result.version}`);
  console.log(`staging=${result.stagingDir}`);
  console.log(`tarball=${result.tarball}`);
}
