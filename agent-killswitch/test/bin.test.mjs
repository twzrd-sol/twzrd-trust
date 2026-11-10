// The package ships a bin entry so `npx @twzrd1111/agent-killswitch` starts
// the proxy and not just installs it. Guard that contract: package.json
// points at a built file with a node shebang, and running that file as a
// CLI reaches "listening" without touching the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package.json bin entry points at a built file with a node shebang", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
  assert.equal(pkg.bin?.["agent-killswitch"], "./dist/index.js");
  const binPath = path.join(pkgRoot, pkg.bin["agent-killswitch"]);
  assert.ok(fs.existsSync(binPath), "bin target must exist after build");
  assert.ok(
    fs.readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node"),
    "bin target must start with the node shebang",
  );
});

test("the bin runs through a symlink whose name differs from the target (the npm/npx shim path)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "killswitch-shim-"));
  const shim = path.join(tmp, "agent-killswitch");
  fs.chmodSync(path.join(pkgRoot, "dist", "index.js"), 0o755); // npm does this at install
  fs.symlinkSync(path.join(pkgRoot, "dist", "index.js"), shim);
  const child = spawn(shim, [], {
    cwd: tmp,
    env: {
      ...process.env,
      OPENAI_API_KEY: "sk-test-dummy",
      KILLSWITCH_PORT: "0",
      KILLSWITCH_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const out = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`no listening line; got: ${buf}`)), 10000);
      child.stdout.on("data", (d) => {
        buf += d;
        if (buf.includes("listening on")) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
      child.stderr.on("data", (d) => {
        buf += d;
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`exited early (code ${code}); got: ${buf}`));
      });
    });
    assert.match(out, /listening on 127\.0\.0\.1:/);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the bin target starts the proxy when run as a CLI", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "killswitch-bin-"));
  const child = spawn(process.execPath, [path.join(pkgRoot, "dist", "index.js")], {
    cwd: tmp,
    env: {
      ...process.env,
      OPENAI_API_KEY: "sk-test-dummy",
      KILLSWITCH_PORT: "0",
      KILLSWITCH_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const out = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`no listening line; got: ${buf}`)), 10000);
      child.stdout.on("data", (d) => {
        buf += d;
        if (buf.includes("listening on")) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
      child.stderr.on("data", (d) => {
        buf += d;
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`exited early (code ${code}); got: ${buf}`));
      });
    });
    assert.match(out, /listening on 127\.0\.0\.1:/);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a port already in use exits 1 with one actionable line, not a stack trace", async () => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const port = blocker.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "killswitch-port-in-use-"));
  const child = spawn(process.execPath, [path.join(pkgRoot, "dist", "index.js")], {
    cwd: tmp,
    env: {
      ...process.env,
      OPENAI_API_KEY: "sk-test-dummy",
      KILLSWITCH_PORT: String(port),
      KILLSWITCH_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`did not exit; stderr: ${stderr}`)), 10000);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.equal(code, 1);
    assert.equal(
      stderr,
      `agent-killswitch: port ${port} on 127.0.0.1 is already in use. ` +
        `Set KILLSWITCH_PORT to a free port, for example KILLSWITCH_PORT=${port + 1}.\n`,
    );
  } finally {
    child.kill("SIGKILL");
    blocker.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
