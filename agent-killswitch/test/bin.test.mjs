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

// Run the CLI in a fresh directory with no inherited killswitch settings.
// `env` and `setup` receive that directory. Resolves once the process exits.
async function runToExit(env = () => ({}), setup = () => {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "killswitch-startup-"));
  setup(tmp);
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => k !== "OPENAI_API_KEY" && k !== "PORT" && k !== "TWZRD_STATE_DIR" && !k.startsWith("KILLSWITCH_"),
    ),
  );
  const child = spawn(process.execPath, [path.join(pkgRoot, "dist", "index.js")], {
    cwd: tmp,
    env: { ...base, KILLSWITCH_HOST: "127.0.0.1", ...env(tmp) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`did not exit; stderr: ${stderr}`)), 10000);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    return { code, stderr, tmp };
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const KEY = { OPENAI_API_KEY: "sk-test-dummy" };
const startupFailures = [
  {
    name: "a missing upstream API key",
    env: () => ({}),
    line: "agent-killswitch: Upstream API key missing: set OPENAI_API_KEY, or list free models in KILLSWITCH_FREE_MODELS",
  },
  {
    name: "a missing key under a renamed key variable",
    env: () => ({ KILLSWITCH_API_KEY_ENV: "MY_UPSTREAM_KEY" }),
    line: "agent-killswitch: Upstream API key missing: set MY_UPSTREAM_KEY, or list free models in KILLSWITCH_FREE_MODELS",
  },
  {
    name: "a missing key under a binding policy",
    setup: (tmp) => fs.writeFileSync(path.join(tmp, "config.yaml"), "schema: twzrd.binding_policy.v1\ncompute: {}\n"),
    line:
      "agent-killswitch: Upstream API key missing: set OPENAI_API_KEY, " +
      "or list free models in KILLSWITCH_FREE_MODELS or compute.free_models",
  },
  {
    name: "unparseable model rates",
    env: () => ({ ...KEY, KILLSWITCH_MODEL_RATES: "not-json" }),
    line: "agent-killswitch: Invalid KILLSWITCH_MODEL_RATES JSON rates",
  },
  {
    name: "a non-numeric limit",
    env: () => ({ ...KEY, KILLSWITCH_MAX_USD_DAY: "lots" }),
    line: "agent-killswitch: KILLSWITCH_MAX_USD_DAY must be a non-negative number, got 'lots'",
  },
  {
    name: "a port out of range",
    env: () => ({ ...KEY, KILLSWITCH_PORT: "99999" }),
    line: "agent-killswitch: KILLSWITCH_PORT must be a whole number from 0 to 65535, got '99999'",
  },
  {
    name: "a fractional port in the config file",
    env: () => KEY,
    setup: (tmp) => fs.writeFileSync(path.join(tmp, "config.yaml"), "server:\n  port: 4020.5\n"),
    line: "agent-killswitch: server.port must be a whole number from 0 to 65535, got '4020.5'",
  },
  {
    name: "a config file that is not valid YAML",
    env: () => KEY,
    setup: (tmp) => fs.writeFileSync(path.join(tmp, "config.yaml"), "a: [1\n"),
    line:
      "agent-killswitch: Config file ./config.yaml is not valid YAML: " +
      "unexpected end of the stream within a flow collection (2:1)",
  },
  {
    name: "a ledger path that is a directory",
    env: (tmp) => ({ ...KEY, KILLSWITCH_PORT: "0", KILLSWITCH_LEDGER_PATH: path.join(tmp, "ledger-dir") }),
    setup: (tmp) => fs.mkdirSync(path.join(tmp, "ledger-dir")),
    // The OS text after the path varies by platform; the prefix is ours.
    prefix: (tmp) => `agent-killswitch: cannot read the ledger at ${path.join(tmp, "ledger-dir")}: `,
  },
];

for (const c of startupFailures) {
  test(`${c.name} exits 1 with one actionable line, not a stack trace`, async () => {
    let realTmp = "";
    const { code, stderr } = await runToExit(c.env, (tmp) => {
      realTmp = tmp;
      c.setup?.(tmp);
    });
    assert.equal(code, 1, `stderr: ${stderr}`);
    const lines = stderr.split("\n").filter((l) => l.startsWith("agent-killswitch: "));
    assert.equal(lines.length, 1, `stderr: ${stderr}`);
    if (c.line) assert.equal(lines[0], c.line);
    else assert.ok(lines[0].startsWith(c.prefix(realTmp)), `got: ${lines[0]}`);
    assert.doesNotMatch(stderr, /node:internal|^\s+at /m);
  });
}

test("an empty KILLSWITCH_PORT means unset: the config file's port is used, not a random one", async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "killswitch-empty-port-"));
  fs.writeFileSync(path.join(tmp, "config.yaml"), `server:\n  port: ${port}\n`);
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "PORT" && !k.startsWith("KILLSWITCH_")),
  );
  const child = spawn(process.execPath, [path.join(pkgRoot, "dist", "index.js")], {
    cwd: tmp,
    env: { ...base, ...KEY, KILLSWITCH_PORT: "", KILLSWITCH_HOST: "127.0.0.1" },
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
    assert.match(out, new RegExp(`listening on 127\\.0\\.0\\.1:${port}\\b`));
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
    // Match the line, not the whole stream: a Node warning on stderr must
    // not fail this, but a stack trace must.
    const other = port < 65535 ? port + 1 : port - 1;
    assert.ok(
      stderr.split("\n").includes(
        `agent-killswitch: port ${port} on 127.0.0.1 is already in use ` +
          `(another agent-killswitch may be running). ` +
          `Set KILLSWITCH_PORT to a free port, for example KILLSWITCH_PORT=${other}.`,
      ),
      `missing the port-in-use line; stderr: ${stderr}`,
    );
    assert.doesNotMatch(stderr, /EADDRINUSE|node:events|^\s+at /m);
  } finally {
    child.kill("SIGKILL");
    blocker.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
