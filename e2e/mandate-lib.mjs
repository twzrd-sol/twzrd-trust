// End-to-end harness for @twzrd1111/mandate: the built `mandate serve`
// sidecar and the twzrd-sentinel daemon, run as child processes the way an
// operator runs them, against a loopback seller, trust service, paid MCP
// server and OpenAI-compatible upstream. Nothing leaves 127.0.0.1.
//
// What a run did is then checked from outside the package: the three ledger
// files are re-read here (the decision ledger's chain is recomputed with
// plain SHA-256, the two spend ledgers with agent-killswitch's verifier),
// and a receipt is checked with the reference verifier as well as the gate's.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { verifyLedgerFile } from "../agent-killswitch/dist/chain.js";
import {
  createLoopbackPayer,
  generateKeyFile,
  issueMandate,
  startLoopbackWorld,
  writeMandateFile,
} from "../twzrd-mandate/dist/index.js";
import { verifyReceiptBinding } from "../twzrd-x402-gate/dist/index.js";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const MANDATE_CLI = path.join(ROOT, "twzrd-mandate", "dist", "cli.js");
export const SENTINEL_CLI = path.join(ROOT, "examples", "autonomous-sentinel", "sentinel.mjs");
export const MANDATE_INDEX = path.join(ROOT, "twzrd-mandate", "dist", "index.js");
/** Pinned receipt issuer key; docs/receipt-v6-spec.md publishes the same value. */
export const PINNED_RECEIPT_KEY = "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS";
export const MICRO = 1_000_000;
/** USD per million tokens. CHEAP makes an honest answer cost 0.002 USD; DEAR makes the reserve for 100 output tokens 0.20 USD. */
export const CHEAP_RATES = { "test-model": { in: 1, out: 2 } };
export const DEAR_RATES = { "test-model": { in: 1000, out: 2000 } };

// The reference verifier is a dependency of the Eliza plugin workspace.
const referenceVerifier = createRequire(path.join(ROOT, "eliza-plugin-source", "package.json"))("twzrd-receipt-verifier");

/** A child's environment: the host's, without anything the gate or the guard would read. */
export function childEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(TWZRD_|KILLSWITCH_)/.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

export const tempDir = (prefix = "twzrd-e2e-mandate-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const micro = (usd) => Math.round(Number(usd ?? 0) * MICRO);
const jsonLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0) : []);

/** An OpenAI-compatible stub. `usage` is what it reports; `undefined` leaves the member out. */
export async function startUpstream() {
  const stub = { usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }, requests: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      stub.requests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion",
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          ...(stub.usage === undefined ? {} : { usage: stub.usage }),
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.base = `http://127.0.0.1:${server.address().port}/v1`;
  stub.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}

/** Run a command to completion. */
export function runCli(cli, args, cwd, env = {}) {
  const out = spawnSync(process.execPath, [cli, ...args], { cwd, env: childEnv(env), encoding: "utf8", timeout: 90_000 });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

/**
 * Write a mandate, an agent key and a pay module into a fresh directory.
 * The pay module is the loopback payer (a fixed throwaway key the loopback
 * seller accepts) and appends a line to signatures.log for every request it
 * sends carrying a payment, so a test can count signatures from outside.
 */
export function writeFixtureDir(world, overrides = {}, opts = {}) {
  const dir = tempDir();
  const agentKey = generateKeyFile(path.join(dir, "agent.json"));
  const tool = `http:127.0.0.1:${new URL(world.base).port}`;
  const mandate = issueMandate({
    issuerMode: "self-mandated",
    issuerKey: agentKey,
    maxPerCallUsd: "0.05",
    dailyCeilingUsd: "1.00",
    allowedChains: ["solana"],
    minTrustScore: 75,
    allowedTools: [tool, "mcp:paid_lookup", "mcp:echo", "inference"],
    requireV7Receipt: true,
    requireMerkleInclusion: true,
    killswitchDir: ".twzrd-mandate",
    lifetimeMs: 3_600_000,
    ...overrides,
  });
  writeMandateFile(path.join(dir, "mandate.json"), mandate);
  const signatureLog = path.join(dir, "signatures.log");
  if (opts.payer !== false) {
    fs.writeFileSync(
      path.join(dir, "pay.mjs"),
      [
        `import fs from "node:fs";`,
        `import { createLoopbackPayer } from ${JSON.stringify(MANDATE_INDEX)};`,
        `const payer = createLoopbackPayer();`,
        `export const wrapPay = (guarded) =>`,
        `  payer.wrapPay(async (input, init) => {`,
        `    const request = new Request(input, init);`,
        `    if (request.headers.has("x-payment")) fs.appendFileSync(${JSON.stringify(signatureLog)}, "1\\n");`,
        `    return guarded(request);`,
        `  });`,
        ``,
      ].join("\n"),
    );
  }
  return { dir, agentKey, mandate, tool, signatureLog, stateDir: path.join(dir, ".twzrd-mandate") };
}

/** Start `mandate serve` in `dir`. Resolves once it is listening; rejects with its stderr if it exits first. */
export function startServe(dir, args, env = {}) {
  const child = spawn(process.execPath, [MANDATE_CLI, "serve", "--port", "0", "--quiet", ...args], { cwd: dir, env: childEnv(env), stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start: ${stderr}`)), 20_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited ${code}: ${stderr}`));
    });
  });
  return {
    ready,
    exited,
    stderr: () => stderr,
    async stop() {
      child.kill("SIGTERM");
      await exited;
    },
  };
}

/**
 * A whole stack: loopback world, mandate on disk, and a running sidecar with
 * the MCP proxy and (with `inference: true`) the metered /v1 route.
 */
export async function startStack(overrides = {}, opts = {}) {
  const world = await startLoopbackWorld(createLoopbackPayer().publicKey);
  const upstream = opts.inference ? await startUpstream() : null;
  const fixture = writeFixtureDir(world, overrides, opts);
  const args = ["--agent-key", "agent.json", "--mcp-upstream", world.mcpUrl, "--intel-base", world.intelBase];
  if (opts.payer !== false) args.push("--pay-module", "pay.mjs");
  if (upstream) {
    fs.writeFileSync(path.join(fixture.dir, "rates.json"), JSON.stringify(opts.rates ?? CHEAP_RATES));
    args.push("--upstream", upstream.base, "--upstream-key-env", "E2E_UPSTREAM_KEY", "--model-rates", "rates.json");
  }
  const serve = startServe(fixture.dir, args, upstream ? { E2E_UPSTREAM_KEY: "sk-loopback-e2e" } : {});
  let url;
  try {
    url = await serve.ready;
  } catch (err) {
    await world.close();
    if (upstream) await upstream.close();
    throw err;
  }
  const stack = {
    ...fixture,
    world,
    upstream,
    url,
    serve,
    signatures: () => jsonLines(fixture.signatureLog).length,
    pay: (name, init) => fetch(`${url}/pay/${world.url(name)}`, init),
    mcp: (name, id = 1) =>
      fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }) }).then((r) => r.json()),
    chat: (body = {}) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...body }),
      }),
    status: () => fetch(`${url}/mandate/status`).then((r) => r.json()),
    resume: () =>
      fetch(`${url}/mandate/resume`, { method: "POST", headers: { authorization: `Bearer ${fs.readFileSync(path.join(fixture.stateDir, "control.token"), "utf8").trim()}` } }),
    async close() {
      await serve.stop();
      await world.close();
      if (upstream) await upstream.close();
    },
  };
  return stack;
}

/** A free loopback port: bound, read, released. */
export async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Start `twzrd-sentinel run --json` as a daemon. `events` fills with its
 * stdout lines as they arrive; `until(probe)` waits for the events to satisfy it.
 */
export function startSentinel(dir, args, env = {}) {
  const child = spawn(process.execPath, [SENTINEL_CLI, "run", "--dir", dir, "--json", ...args], { cwd: dir, env: childEnv(env), stdio: ["ignore", "pipe", "pipe"] });
  const events = [];
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    let at;
    while ((at = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, at);
      stdout = stdout.slice(at + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  let exitCode = null;
  const exited = new Promise((resolve) =>
    child.on("exit", (code) => {
      exitCode = code;
      resolve(code);
    }),
  );
  return {
    events,
    exited,
    stderr: () => stderr,
    heartbeats: () => events.filter((e) => e.event === "heartbeat"),
    until: (probe, timeoutMs = 20_000) => eventually(() => exitCode !== null || probe(events), timeoutMs).then(() => probe(events)),
    async stop() {
      child.kill("SIGTERM");
      return exited;
    },
  };
}

/** Recompute a decision ledger's chain with plain SHA-256. */
export function readDecisionLedger(stateDir) {
  const lines = jsonLines(path.join(stateDir, "mandate-ledger.jsonl"));
  const rows = lines.map((line) => JSON.parse(line));
  let chainOk = true;
  rows.forEach((row, i) => {
    const expected = i === 0 ? "genesis" : crypto.createHash("sha256").update(lines[i - 1]).digest("hex");
    if (row.prev !== expected || row.seq !== i + 1) chainOk = false;
  });
  const head = lines.length ? crypto.createHash("sha256").update(lines.at(-1)).digest("hex") : "genesis";
  return { rows, chainOk, head };
}

/**
 * Stage 7, from outside the package: the three ledgers each chain, and the
 * money they record is the money the seller received.
 */
export function reconcile(stateDir, world, mandateId) {
  const mismatches = [];
  const decision = readDecisionLedger(stateDir);
  if (!decision.chainOk) mismatches.push("the decision ledger's chain does not verify");
  const calls = decision.rows.filter((row) => row.outcome !== "control");
  const decisionMicro = calls.filter((row) => row.outcome === "settled" || row.outcome === "violation").reduce((sum, row) => sum + micro(row.settledUsd), 0);
  const signatures = calls.reduce((sum, row) => sum + row.signatures, 0);
  const refusedSigned = calls.filter((row) => row.outcome === "refused" && row.signatures !== 0).length;
  if (refusedSigned !== 0) mismatches.push(`${refusedSigned} refusal(s) carry a signature`);

  const toolFile = path.join(stateDir, "spend-ledger.jsonl");
  if (fs.existsSync(toolFile) && !verifyLedgerFile(toolFile).ok) mismatches.push("the tool spend ledger's chain does not verify");
  const toolRows = jsonLines(toolFile).map((line) => JSON.parse(line));
  const toolMicro = toolRows.filter((row) => row.allowed === true && row.model === "(tool)").reduce((sum, row) => sum + micro(row.cost_usd), 0);

  const gateFile = path.join(stateDir, "payment-spend-ledger.jsonl");
  if (fs.existsSync(gateFile) && !verifyLedgerFile(gateFile).ok) mismatches.push("the gate spend ledger's chain does not verify");
  const gateMicro = jsonLines(gateFile)
    .map((line) => JSON.parse(line))
    .filter((row) => row.scope === `mandate:${mandateId}`)
    .reduce((sum, row) => sum + Number(row.micro), 0);

  // A daemon's seller lives in the daemon's process; then there is no world to read here.
  const sellerMicro = world ? world.receivedMicro : null;
  if (decisionMicro !== toolMicro) mismatches.push(`decision ledger ${decisionMicro} != tool ledger ${toolMicro}`);
  if (decisionMicro !== gateMicro) mismatches.push(`decision ledger ${decisionMicro} != gate ledger ${gateMicro}`);
  return { ok: mismatches.length === 0, mismatches, decisionMicro, toolMicro, gateMicro, sellerMicro, signatures, rows: decision.rows, head: decision.head };
}

/** Stage 6, from outside the package: both verifiers accept the receipt under the pinned key. */
export function verifyReceiptTwice(receipt) {
  const binding = verifyReceiptBinding(receipt, [PINNED_RECEIPT_KEY]);
  let reference = { valid: false };
  try {
    reference = referenceVerifier.verify(receipt, PINNED_RECEIPT_KEY);
  } catch {
    // a receipt the reference verifier cannot parse is not valid
  }
  return { ok: binding.ok === true && reference.valid === true, bindingOk: binding.ok === true, referenceOk: reference.valid === true, subject: receipt?.preimage?.agent_id ?? null };
}

/** Wait until `probe()` is true, or five seconds pass. */
export async function eventually(probe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
