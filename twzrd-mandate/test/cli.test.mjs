// The `mandate` command, run as a child process the way `npx` runs it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VERSION, createLoopbackPayer, startLoopbackWorld, verifyBreakers } from "../dist/index.js";
import { tempDir } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function cleanedEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(TWZRD_|KILLSWITCH_)/.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

function run(cwd, args, env = {}) {
  const out = spawnSync(process.execPath, [CLI, ...args], { cwd, env: cleanedEnv(env), encoding: "utf8", timeout: 60_000 });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

/** Start `mandate serve` (or another long-running command) and wait for a line on stderr. */
function start(cwd, args, waitFor, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: cleanedEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${waitFor}; stderr: ${stderr}`)), 20_000);
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
      const match = waitFor.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code} before ${waitFor}; stderr: ${stderr}`));
    });
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, ready, exited, out: () => stdout, err: () => stderr };
}

test("help, version and unknown commands", () => {
  const dir = tempDir();
  assert.equal(run(dir, ["--version"]).stdout.trim(), VERSION);
  const help = run(dir, ["help"]);
  assert.equal(help.code, 0);
  for (const word of ["init", "self-issue", "session", "serve", "mcp-stdio", "verify-breakers", "--pay-module", "--mcp-upstream"]) assert.ok(help.stdout.includes(word), word);
  const unknown = run(dir, ["explode"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command/);
  assert.equal(unknown.stderr.includes("at "), false, "a usage error printed a stack trace");
  assert.equal(run(dir, ["init", "--dialy", "5"]).code, 2);
});

test("init: the 60-second path writes a verifying operator mandate and two key files", () => {
  const dir = tempDir();
  const init = run(dir, ["init", "--daily", "5.00", "--min-trust", "75"]);
  assert.equal(init.code, 0, init.stderr);
  const mandate = JSON.parse(fs.readFileSync(path.join(dir, "mandate.json"), "utf8"));
  assert.deepEqual(
    [mandate.schema, mandate.issuerMode, mandate.limits.dailyCeilingUsd, mandate.limits.maxPerCallUsd, mandate.minTrustScore, mandate.allowedChains, mandate.killswitchDir],
    ["twzrd.mandate.v1", "human-operator", "5.00", "0.1", 75, ["solana"], ".twzrd-mandate"],
  );
  assert.notEqual(mandate.issuer, mandate.agent);
  // The default tool list lets the quickstart's MCP step work: TWZRD's paid routes and its trust tools, nothing wider.
  assert.deepEqual(mandate.allowedTools, ["http:intel.twzrd.xyz", "mcp:evaluate_x402_resource", "mcp:get_merchant_card", "mcp:get_readiness_card_tool", "mcp:verify_receipt"]);
  for (const file of ["operator.json", "agent.json"]) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600, file);
  assert.match(init.stdout, /claude mcp add --transport http twzrd-mandate http:\/\/127\.0\.0\.1:4029\/mcp/);
  assert.equal(init.stdout.includes(fs.readFileSync(path.join(dir, "agent.json"), "utf8").slice(1, 40)), false, "key material was printed");

  // Verification needs to be told which operator to trust.
  const untrusted = run(dir, ["verify"]);
  assert.equal(untrusted.code, 1);
  assert.match(untrusted.stdout, /INVALID\s+mandate_issuer_untrusted/);
  const trusted = run(dir, ["verify", "mandate.json", "--trust-issuer", mandate.issuer]);
  assert.equal(trusted.code, 0, trusted.stdout);
  assert.match(trusted.stdout, /^VALID/);
  assert.equal(run(dir, ["verify"], { TWZRD_MANDATE_TRUSTED_ISSUERS: `x, ${mandate.issuer}` }).code, 0);

  // It will not overwrite a mandate without being told to.
  const again = run(dir, ["init", "--daily", "9.00"]);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already exists/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "mandate.json"), "utf8")).limits.dailyCeilingUsd, "5.00");
  assert.equal(run(dir, ["init", "--daily", "9.00", "--force"]).code, 0);

  // An edited mandate no longer verifies.
  const edited = JSON.parse(fs.readFileSync(path.join(dir, "mandate.json"), "utf8"));
  edited.limits.dailyCeilingUsd = "900.00";
  fs.writeFileSync(path.join(dir, "mandate.json"), JSON.stringify(edited));
  const tampered = run(dir, ["verify", "--trust-issuer", edited.issuer]);
  assert.equal(tampered.code, 1);
  assert.match(tampered.stdout, /mandate_signature_invalid/);
});

test("self-issue and session: signed by the agent's own key, with every limit flag honoured", () => {
  const dir = tempDir();
  const self = run(dir, ["self-issue", "--agent-key", "./agent.json", "--daily", "2.00"]);
  assert.equal(self.code, 0, self.stderr);
  const mandate = JSON.parse(fs.readFileSync(path.join(dir, "mandate.json"), "utf8"));
  assert.deepEqual([mandate.issuerMode, mandate.issuer === mandate.agent, mandate.limits.dailyCeilingUsd], ["self-mandated", true, "2.00"]);
  assert.equal(run(dir, ["verify", "--agent-key", "agent.json"]).code, 0);
  assert.equal(run(dir, ["verify"]).code, 1, "a self-signed mandate verified without the agent key");

  const full = run(dir, [
    "session", "--agent-key", "agent.json", "--task", "price three lookups", "--daily", "0.50", "--per-call", "0.05", "--hourly", "0.25",
    "--min-trust", "90", "--chains", "solana,base", "--tools", "http:intel.twzrd.xyz,mcp:get_merchant_card,inference",
    "--block-counterparty", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "--require-inclusion", "--expires", "45m", "--state-dir", "state", "--out", "session.json",
  ]);
  assert.equal(full.code, 0, full.stderr);
  const session = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
  assert.deepEqual(
    [session.issuerMode, session.task, session.limits, session.minTrustScore, session.allowedChains, session.allowedTools.length, session.requireV7Receipt, session.requireMerkleInclusion, session.killswitchDir],
    ["ephemeral-session", "price three lookups", { maxPerCallUsd: "0.05", hourlyCeilingUsd: "0.25", dailyCeilingUsd: "0.50" }, 90, ["solana", "base"], 3, true, true, "state"],
  );
  assert.equal(Date.parse(session.expiresAt) - Date.parse(session.issuedAt), 45 * 60_000);

  const refusals = [
    [["self-issue", "--daily", "2.00"], /--agent-key/],
    [["self-issue", "--agent-key", "a.json"], /--daily/],
    [["self-issue", "--agent-key", "a.json", "--daily", "two"], /USD amount/],
    [["self-issue", "--agent-key", "a.json", "--daily", "2.00", "--min-trust", "101"], /0 to 100/],
    [["self-issue", "--agent-key", "a.json", "--daily", "2.00", "--chains", "tempo"], /solana and base/],
    [["self-issue", "--agent-key", "a.json", "--daily", "2.00", "--per-call", "3.00"], /cannot issue/],
    [["self-issue", "--agent-key", "a.json", "--daily", "2.00", "--tools", "*"], /cannot issue/],
    [["self-issue", "--agent-key", "a.json", "--daily", "2.00", "--expires", "400d"], /366 days/],
    [["session", "--agent-key", "a.json", "--daily", "2.00"], /--task/],
    [["session", "--agent-key", "a.json", "--daily", "2.00", "--task", "t", "--expires", "2d"], /24 hours/],
  ];
  for (const [args, message] of refusals) {
    const out = run(dir, [...args, "--out", "refused.json"]);
    assert.notEqual(out.code, 0, args.join(" "));
    assert.match(out.stderr, message, args.join(" "));
    assert.equal(fs.existsSync(path.join(dir, "refused.json")), false, `${args.join(" ")} wrote a mandate`);
  }
});

test("verify-breakers: all six layers, zero signatures, as a library call and as a command", async () => {
  const report = await verifyBreakers();
  assert.equal(report.ok, true, JSON.stringify(report.cases.filter((c) => !c.passed)));
  assert.deepEqual(report.layersProven, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([report.totalSignatures, report.totalSellerPayments, report.strayRequests], [0, 0, 0]);
  assert.ok(report.cases.length >= 12);
  for (const layer of [1, 2, 3, 4, 5, 6]) assert.ok(report.cases.some((c) => c.layer === layer && c.passed));
  const dir = tempDir();
  // A hostile environment does not change the outcome.
  const out = run(dir, ["verify-breakers", "--json"], { TWZRD_FAIL_OPEN: "1", TWZRD_PREFLIGHT_MIN_SCORE: "0", TWZRD_INTEL_BASE: "http://127.0.0.1:9", TWZRD_STATE_DIR: dir });
  assert.equal(out.code, 0, out.stderr);
  const doc = JSON.parse(out.stdout);
  assert.deepEqual([doc.schema, doc.ok, doc.totalSignatures], ["twzrd.mandate.breakers.v1", true, 0]);
  assert.match(run(dir, ["verify-breakers"]).stdout, /RESULT: every pre-sign layer refused with 0 signatures/);
  assert.deepEqual(fs.readdirSync(dir), [], "verify-breakers left files in the working directory");
});

test("serve refuses to start on a mandate it cannot trust, and says why in one line", () => {
  const dir = tempDir();
  run(dir, ["init", "--daily", "5.00"]);
  const mandate = JSON.parse(fs.readFileSync(path.join(dir, "mandate.json"), "utf8"));
  const cases = [
    [["serve", "--port", "0"], /mandate_issuer_untrusted/],
    [["serve", "--port", "0", "--mandate", "absent.json"], /mandate_malformed/],
    [["serve", "--port", "0", "--trust-issuer", mandate.issuer, "--host", "0.0.0.0"], /loopback only/],
    [["serve", "--port", "0", "--trust-issuer", mandate.issuer, "--upstream", "http://127.0.0.1:9/v1"], /allowedTools/],
    [["serve", "--port", "0", "--trust-issuer", mandate.issuer, "--pay-module", "absent.mjs"], /absent\.mjs|Cannot find/],
  ];
  for (const [args, message] of cases) {
    const out = run(dir, args);
    assert.notEqual(out.code, 0, args.join(" "));
    assert.match(out.stderr, message, args.join(" "));
  }
  // A self-signed mandate needs the key it names, not just any key.
  const other = tempDir();
  run(other, ["self-issue", "--agent-key", "agent.json", "--daily", "1.00"]);
  run(other, ["self-issue", "--agent-key", "intruder.json", "--daily", "1.00", "--out", "unused.json"]);
  const wrong = run(other, ["serve", "--port", "0", "--agent-key", "intruder.json"]);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /refusing to start/);
});

test("serve, then status, kill, resume and ledger against the running sidecar", async () => {
  const payer = createLoopbackPayer();
  const world = await startLoopbackWorld(payer.publicKey);
  const dir = tempDir();
  const tool = `http:127.0.0.1:${new URL(world.base).port}`;
  assert.equal(run(dir, ["self-issue", "--agent-key", "agent.json", "--daily", "1.00", "--tools", `${tool},mcp:echo,mcp:paid_lookup`]).code, 0);
  // A pay module that pays nothing: enough to prove it is loaded and consulted.
  fs.writeFileSync(path.join(dir, "pay.mjs"), "export const wrapPay = (guarded) => guarded;\n");
  const serve = start(dir, ["serve", "--port", "0", "--agent-key", "agent.json", "--pay-module", "pay.mjs", "--mcp-upstream", world.mcpUrl, "--intel-base", world.intelBase, "--quiet"], /listening on (http:\/\/127\.0\.0\.1:\d+)/);
  try {
    const url = (await serve.ready)[1];
    assert.match(serve.err(), /payer\s+configured/);
    const status = run(dir, ["status", "--url", url]);
    assert.equal(status.code, 0, status.stderr);
    const doc = JSON.parse(status.stdout);
    assert.deepEqual([doc.schema, doc.payer, doc.routes.mcp, doc.halt.active], ["twzrd.mandate.status.v1", "configured", true, false]);

    // A free call through /pay, then a paid one the pay module declines to pay.
    world.product("gratis").free = true;
    assert.equal((await fetch(`${url}/pay/${world.url("gratis")}`)).status, 200);
    const unpaid = await fetch(`${url}/pay/${world.url("ok")}`);
    assert.equal(unpaid.status, 403);
    assert.equal((await unpaid.json()).error.code, "payment_not_made");

    // The MCP proxy answers through the same process.
    const echo = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } }) });
    assert.equal((await echo.json()).id, 1);

    const ledger = run(dir, ["ledger", "--url", url, "--limit", "10"]);
    const rows = JSON.parse(ledger.stdout);
    assert.deepEqual([rows.chainVerified, rows.records.map((r) => r.outcome)], [true, ["free", "refused", "free"]]);
    assert.equal(JSON.parse(run(dir, ["ledger", "--verify"]).stdout).ok, true);

    const killed = run(dir, ["kill", "--url", url, "--reason", "test"]);
    assert.equal(JSON.parse(killed.stdout).killed, true);
    assert.equal((await fetch(`${url}/pay/${world.url("gratis")}`)).status, 403);
    assert.ok(fs.existsSync(path.join(dir, ".twzrd-mandate", ".kill")));
    const resumed = run(dir, ["resume", "--url", url]);
    assert.deepEqual(JSON.parse(resumed.stdout).removed, [".kill"]);
    assert.equal((await fetch(`${url}/pay/${world.url("gratis")}`)).status, 200);

    // A second sidecar on the same state directory is refused.
    const second = run(dir, ["serve", "--port", "0", "--agent-key", "agent.json"]);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /in use by process/);
  } finally {
    serve.child.kill("SIGTERM");
    await serve.exited;
    await world.close();
  }
  // With no sidecar: kill writes the file directly, resume clears it, status says nothing is listening.
  assert.equal(fs.existsSync(path.join(dir, ".twzrd-mandate", "mandate.lock")), false, "the lock outlived the sidecar");
  assert.match(JSON.parse(run(dir, ["kill"]).stdout).killFile, /\.kill$/);
  assert.deepEqual(JSON.parse(run(dir, ["resume", "--url", "http://127.0.0.1:9"]).stdout).removed, [".kill"]);
  const down = run(dir, ["status", "--url", "http://127.0.0.1:9"]);
  assert.equal(down.code, 2);
  assert.match(down.stderr, /no sidecar answered/);
});

test("mcp-stdio: the proxy over stdio, and as a bridge to a running sidecar", async () => {
  const payer = createLoopbackPayer();
  const world = await startLoopbackWorld(payer.publicKey);
  const dir = tempDir();
  run(dir, ["self-issue", "--agent-key", "agent.json", "--daily", "1.00", "--tools", "mcp:echo,mcp:paid_lookup"]);
  const talk = async (args) => {
    const proc = start(dir, args, /never/);
    proc.ready.catch(() => {});
    const send = (doc) => proc.child.stdin.write(`${JSON.stringify(doc)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: {} } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "paid_lookup", arguments: {} } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "unlisted_tool", arguments: {} } });
    const deadline = Date.now() + 15_000;
    const lines = () => proc.out().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    while (lines().filter((l) => l.id !== undefined).length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    proc.child.stdin.end();
    const code = await proc.exited;
    return { code, byId: Object.fromEntries(lines().map((l) => [l.id, l])), err: proc.err() };
  };
  try {
    const direct = await talk(["mcp-stdio", "--agent-key", "agent.json", "--mcp-upstream", world.mcpUrl, "--intel-base", world.intelBase]);
    assert.equal(direct.code, 0, direct.err);
    assert.equal(direct.byId[1].result.tools.length, 3);
    assert.equal(direct.byId[2].result.isError ?? false, false);
    assert.equal(direct.byId[3].result.structuredContent.twzrd_mandate.code, "no_payer_configured");
    assert.equal(direct.byId[4].result.structuredContent.twzrd_mandate.code, "tool_not_allowed");

    const serve = start(dir, ["serve", "--port", "0", "--agent-key", "agent.json", "--mcp-upstream", world.mcpUrl, "--intel-base", world.intelBase, "--quiet"], /listening on (http:\/\/127\.0\.0\.1:\d+)/);
    try {
      const url = (await serve.ready)[1];
      const bridged = await talk(["mcp-stdio", "--sidecar", url]);
      assert.equal(bridged.code, 0, bridged.err);
      assert.equal(bridged.byId[1].result.tools.length, 3);
      assert.equal(bridged.byId[3].result.structuredContent.twzrd_mandate.code, "no_payer_configured");
      assert.equal(bridged.byId[4].result.structuredContent.twzrd_mandate.code, "tool_not_allowed");
    } finally {
      serve.child.kill("SIGTERM");
      await serve.exited;
    }
    assert.equal(payer.signatures, 0);
    assert.equal(world.paidCount, 0);
  } finally {
    await world.close();
  }
  const neither = run(dir, ["mcp-stdio", "--agent-key", "agent.json"]);
  assert.equal(neither.code, 2);
  assert.match(neither.stderr, /--sidecar|--mcp-upstream/);
});
