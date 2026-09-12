/**
 * Every package.json bin must stay executable in git and on disk.
 * twzrd-payment-decision shipped 100644 in 4f6cde7; workspace/file: links
 * then exited 126. npm install chmod's extracted bins, so pack-smoke after
 * install cannot catch this — check git + working tree here.
 *
 * Run: npx tsx --test test/bin-mode-contract.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
  bin?: Record<string, string>;
};

function binRels(): string[] {
  return Object.values(pkg.bin ?? {}).map((p) => p.replace(/^\.\//, ""));
}

test("every package.json bin is owner-executable on disk", { skip: process.platform === "win32" }, () => {
  for (const rel of binRels()) {
    const mode = statSync(join(pkgRoot, rel)).mode;
    assert.ok(
      mode & 0o100,
      `${rel} must be owner-executable, mode=${(mode & 0o777).toString(8)}`,
    );
  }
});

test("every package.json bin is 100755 in git", { skip: process.platform === "win32" }, () => {
  const listed = spawnSync("git", ["ls-files", "-s", "--", ...binRels()], {
    cwd: pkgRoot,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  for (const rel of binRels()) {
    const line = listed.stdout.split("\n").find((l) => l.endsWith(`\t${rel}`));
    assert.ok(line, `git ls-files -s missing ${rel}`);
    assert.match(line, /^100755\s/, `${rel} must be 100755 in git, got: ${line}`);
  }
});

test("twzrd-payment-decision shebang exec is not EACCES", { skip: process.platform === "win32" }, () => {
  const bin = join(pkgRoot, "bin/twzrd-payment-decision.js");
  const result = spawnSync(bin, [], { encoding: "utf8" });
  assert.notEqual(
    result.status,
    126,
    `direct exec exited 126 (Permission denied): ${result.stderr}`,
  );
  const spawnErr = result.error as NodeJS.ErrnoException | undefined;
  assert.notEqual(spawnErr?.code, "EACCES");
});
