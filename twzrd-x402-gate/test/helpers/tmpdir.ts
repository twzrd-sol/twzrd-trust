import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

/** Isolated test directory under os.tmpdir(); reaped after tests / process exit. */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const reap = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
  try {
    after(reap);
  } catch {
    // not inside a node:test file (script-style tests still exit-reap)
  }
  process.on("exit", reap);
  return dir;
}
