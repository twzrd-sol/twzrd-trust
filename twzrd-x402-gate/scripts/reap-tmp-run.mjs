#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "reap-run-"));
const env = { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir };
const argv = process.argv.slice(2);
let status = 1;
try {
  const result = argv[0] === "--"
    ? spawnSync(argv[1], argv.slice(2), { stdio: "inherit", env })
    : spawnSync(process.execPath, argv, { stdio: "inherit", env });
  status = result.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
