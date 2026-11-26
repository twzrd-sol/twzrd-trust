// Verifies recipe 3: the published @twzrd1111/mandate sidecar as an MCP proxy in front of a
// loopback paid MCP server. Run: RUN_ROOT=<a temp dir outside the repo> node verify.mjs
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startStub, x402Offer } from "../stub.mjs";

const here = process.cwd();
const cli = join(here, "node_modules/@twzrd1111/mandate/dist/cli.js");
const tripwire = resolve(here, "../tripwire.mjs");
const versions = {};
for (const p of ["@twzrd1111/mandate", "@twzrd1111/mandate/node_modules/twzrd-x402-gate", "twzrd-x402-gate", "@x402/fetch", "@x402/core", "@x402/evm", "viem"]) {
  const f = join(here, "node_modules", p, "package.json");
  if (existsSync(f)) versions[p] = JSON.parse(readFileSync(f, "utf8")).version;
}
// Keys and state live in a temp dir outside the repo (throwaway, loopback only).
const runDir = mkdtempSync(join(process.env.RUN_ROOT ?? "/tmp", "mandate-r3-"));
const TRIPWIRE_LOG = join(runDir, "tripwire.log");
const SIGN_LOG = join(runDir, "sign.log");
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const node = (args) => execFileSync(process.execPath, [cli, ...args], { cwd: runDir, encoding: "utf8" });

// 1. Issue an operator-signed mandate: 0.01 per call, Base only, one MCP tool.
const initOut = node(["init", "--daily", "1.00", "--per-call", "0.01", "--chains", "base", "--tools", "mcp:premium_quote",
  "--expires", "1h", "--state-dir", join(runDir, "state"), "--out", join(runDir, "mandate.json"),
  "--operator-key", join(runDir, "operator.json"), "--agent-key", join(runDir, "agent.json")]);
const issuer = /--trust-issuer\s+(\S+)/.exec(initOut)?.[1];
if (!issuer) throw new Error("init printed no issuer:\n" + initOut);

// 2. Loopback trust service (allow, score 90) and a loopback paid MCP server.
const stub = await startStub({ trust: "allow" });
const mcpHits = [];
let priceMicro = 50000;
let upstreamUrl;
const mcp = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  let msg = {}; try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
  const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })); };
  if (msg.method?.startsWith("notifications/")) { mcpHits.push("mcp:" + msg.method); res.writeHead(202); return res.end(); }
  if (msg.method === "initialize") { mcpHits.push("mcp:initialize");
    return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "loopback-paid-mcp", version: "0" } }); }
  if (msg.method === "tools/list") { mcpHits.push("mcp:tools/list");
    return reply({ tools: [{ name: "premium_quote", description: "a paid loopback tool", inputSchema: { type: "object", properties: {} } }] }); }
  if (msg.method === "tools/call") {
    const paid = msg.params?._meta?.["x402/payment"];
    if (paid) { mcpHits.push("mcp:tools/call:PAID");
      return reply({ content: [{ type: "text", text: JSON.stringify({ quote: 42 }) }],
        _meta: { "x402/payment-response": { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: paid.payload?.authorization?.from } } }); }
    mcpHits.push("mcp:tools/call:unpaid@" + priceMicro);
    const doc = x402Offer(priceMicro, upstreamUrl);
    return reply({ isError: true, structuredContent: doc, content: [{ type: "text", text: JSON.stringify(doc) }] });
  }
  res.writeHead(400); res.end();
});
await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
upstreamUrl = "http://127.0.0.1:" + mcp.address().port + "/mcp";

// 3. The sidecar, with the tripwire preloaded (no non-loopback request can leave it).
const port = 4049;
const serveArgs = ["serve", "--mandate", join(runDir, "mandate.json"), "--agent-key", join(runDir, "agent.json"),
  "--trust-issuer", issuer, "--port", String(port), "--pay-module", join(here, "pay.mjs"),
  "--mcp-upstream", upstreamUrl, "--intel-base", stub.base];
const child = spawn(process.execPath, ["--import", tripwire, cli, ...serveArgs],
  { cwd: runDir, env: { ...process.env, TRIPWIRE_LOG, SIGN_LOG }, stdio: ["ignore", "pipe", "pipe"] });
let serveLog = ""; child.stdout.on("data", (d) => (serveLog += d)); child.stderr.on("data", (d) => (serveLog += d));
const sidecar = "http://127.0.0.1:" + port;
for (let i = 0; i < 100; i++) {
  try { const r = await fetch(sidecar + "/health"); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

// 4. The agent's side: plain MCP over Streamable HTTP to the sidecar.
let sid = null;
async function rpc(message) {
  const r = await fetch(sidecar + "/mcp", { method: "POST", body: JSON.stringify(message),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) } });
  sid = r.headers.get("mcp-session-id") ?? sid;
  const text = await r.text();
  if (!text) return { status: r.status };
  const body = (r.headers.get("content-type") ?? "").includes("text/event-stream")
    ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop()) : JSON.parse(text);
  return { status: r.status, body };
}
const out = { versions, issuerMode: "human-operator", sidecar, upstreamUrl, intelBase: stub.base, cases: {} };
out.init = (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0" } } })).status;
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
out.toolsList = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).body?.result?.tools?.map((t) => t.name);

async function callCase(key, micro, id) {
  priceMicro = micro;
  const before = { signs: lines(SIGN_LOG).length, mcp: mcpHits.length, stub: stub.hits.length };
  const r = await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "premium_quote", arguments: {} } });
  const result = r.body?.result ?? r.body?.error;
  out.cases[key] = { quoteUsdc: String(micro / 1e6), status: r.status, isError: result?.isError ?? null,
    twzrd_mandate: result?.structuredContent?.twzrd_mandate ?? null, content: result?.content?.[0]?.text?.slice(0, 200) ?? null,
    signatures: lines(SIGN_LOG).length - before.signs, upstreamHits: mcpHits.slice(before.mcp), trustHits: stub.hits.slice(before.stub) };
}
await callCase("A_overcap", 50000, 3);
await callCase("B_incap_positive_control", 5000, 4);
out.status = await (await fetch(sidecar + "/mandate/status")).json().catch(() => null);
child.kill("SIGTERM");
await new Promise((r) => child.once("exit", r));
try { out.ledgerVerify = node(["ledger", "--verify", "--mandate", join(runDir, "mandate.json")]).trim().split("\n").slice(-6); }
catch (e) { out.ledgerVerify = { exit: e.status, out: String(e.stdout ?? "").slice(-600) }; }
out.tripwireHits = lines(TRIPWIRE_LOG);
out.serveLogTail = serveLog.split("\n").slice(-12);
out.runDir = runDir;
await stub.close(); mcp.closeAllConnections?.(); await new Promise((r) => mcp.close(r));
console.log(JSON.stringify(out, null, 2));
const a = out.cases.A_overcap;
const pass = a.isError === true && a.twzrd_mandate?.layer === 4 && a.twzrd_mandate?.signatures === 0 && a.signatures === 0
  && !a.upstreamHits.includes("mcp:tools/call:PAID") && a.trustHits.length === 0 && out.tripwireHits.length === 0;
console.log("RESULT recipe3 over-cap refused at layer 4 before signer:", pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
