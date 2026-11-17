// The sidecar: control API, the /pay route, the forward proxy, the MCP proxy
// and the heartbeat, over real loopback sockets.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CONTROL_TOKEN_FILE,
  HEARTBEAT_LOG,
  VERSION,
  createHttpUpstream,
  createMcpGateway,
  emitHeartbeat,
  heartbeatHash,
  lastHeartbeat,
  runMcpStdio,
  startSidecar,
  verifyHeartbeat,
} from "../dist/index.js";
import { makeRig } from "./helpers.mjs";

async function makeSidecar(opts = {}) {
  const rig = await makeRig(opts);
  const mcp = opts.mcp === false ? undefined : createMcpGateway(rig.runtime, createHttpUpstream(rig.world.mcpUrl, { fetch: rig.guard.fetch }));
  const sidecar = await startSidecar({ runtime: rig.runtime, version: VERSION, port: 0, ...(mcp ? { mcp } : {}) });
  return {
    ...rig,
    sidecar,
    url: sidecar.url,
    get: (route, init) => fetch(`${sidecar.url}${route}`, init),
    async close() {
      await sidecar.close();
      mcp?.close();
      await rig.close();
    },
  };
}

/** A raw request, for the things fetch will not send: a chosen Host, an absolute-form target, CONNECT. */
function raw(port, { method = "GET", path: target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, headers: res.headers, text: "" });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function rpc(id, method, params) {
  return { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) };
}

test("the sidecar binds loopback only", async () => {
  const rig = await makeRig();
  try {
    await assert.rejects(() => startSidecar({ runtime: rig.runtime, version: VERSION, host: "0.0.0.0", port: 0 }), /loopback only/);
    await assert.rejects(() => startSidecar({ runtime: rig.runtime, version: VERSION, host: "100.111.36.55", port: 0 }), /loopback only/);
  } finally {
    await rig.close();
  }
});

test("health, status and ledger report the mandate, the spend and a verified chain", async () => {
  const s = await makeSidecar();
  try {
    const health = await (await s.get("/health")).json();
    assert.deepEqual([health.ok, health.service, health.version, health.mandateId, health.expired, health.halted], [true, "twzrd-mandate", VERSION, s.mandate.mandateId, false, false]);
    const paid = await s.get(`/pay/${s.world.url("ok")}`);
    assert.equal(paid.status, 200);
    assert.equal(paid.headers.get("x-twzrd-mandate"), "settled");
    assert.equal((await paid.json()).answer, 42);
    const status = await (await s.get("/mandate/status")).json();
    assert.equal(status.schema, "twzrd.mandate.status.v1");
    assert.deepEqual([status.spend.dayUsd, status.spend.remainingDayUsd, status.counters.signatures, status.payer], ["0.01", "0.99", 1, "configured"]);
    assert.deepEqual(status.routes, { mcp: true, inference: false, pay: true });
    assert.equal(status.mandate.limits.dailyCeilingUsd, "1.00");
    const ledger = await (await s.get("/mandate/ledger?limit=5")).json();
    assert.deepEqual([ledger.schema, ledger.lines, ledger.chainVerified, ledger.records.length], ["twzrd.mandate.ledger.v1", 1, true, 1]);
    assert.equal(ledger.records[0].outcome, "settled");
    assert.equal(ledger.head, status.ledger.head);
    const missing = await s.get("/nope");
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

test("/pay refuses with a JSON document and never forwards a refused call", async () => {
  const s = await makeSidecar();
  try {
    s.world.product("dear").priceMicro = 90_000;
    const resp = await s.get(`/pay/${s.world.url("dear")}`);
    assert.equal(resp.status, 403);
    assert.equal(resp.headers.get("x-twzrd-mandate-code"), "per_request_cap");
    const doc = await resp.json();
    assert.deepEqual([doc.error.type, doc.error.layer, doc.error.code, doc.error.signatures], ["twzrd_mandate_refused", 4, "per_request_cap", 0]);
    assert.equal(s.payer.signatures, 0);
    // A host the mandate does not name.
    const other = await s.get("/pay/http://127.0.0.1:9/x");
    assert.equal((await other.json()).error.code, "tool_not_allowed");
    for (const bad of ["/pay/", "/pay/ftp://x/y", "/pay/not-a-url", "/pay/file:///etc/passwd"]) {
      assert.equal((await s.get(bad)).status, 400, bad);
    }
  } finally {
    await s.close();
  }
});

test("kill needs no token; resume needs the control token from the state directory", async () => {
  const s = await makeSidecar();
  try {
    const killed = await s.get("/mandate/kill", { method: "POST", body: JSON.stringify({ reason: "test" }) });
    assert.equal((await killed.json()).killed, true);
    assert.equal((await s.get(`/pay/${s.world.url("ok")}`)).headers.get("x-twzrd-mandate-code"), "kill_switch");
    assert.equal((await (await s.get("/health")).json()).halted, true);
    // The agent talks to this port. It must not be able to switch itself back on.
    assert.equal((await s.get("/mandate/resume", { method: "POST" })).status, 401);
    assert.equal((await s.get("/mandate/resume", { method: "POST", headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await s.get("/mandate/resume", { method: "POST", headers: { authorization: `Bearer ${"0".repeat(64)}` } })).status, 401);
    const tokenFile = path.join(s.stateDir, CONTROL_TOKEN_FILE);
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    assert.equal(token, s.sidecar.controlToken);
    const resumed = await s.get("/mandate/resume", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual((await resumed.json()).removed, [".kill"]);
    assert.equal((await s.get(`/pay/${s.world.url("ok")}`)).status, 200);
    assert.equal(s.payer.signatures, 1);
  } finally {
    await s.close();
  }
});

test("a web page cannot drive the sidecar: Origin, Sec-Fetch-Site and a foreign Host are refused", async () => {
  const s = await makeSidecar();
  try {
    const port = s.sidecar.port;
    const host = `127.0.0.1:${port}`;
    const paid = `/pay/${s.world.url("ok")}`;
    const attempts = [
      { path: paid, headers: { host, origin: "https://evil.example" } },
      { path: paid, headers: { host, origin: "null" } },
      { path: paid, headers: { host, origin: `http://${host}` } },
      { path: paid, headers: { host, "sec-fetch-site": "cross-site" } },
      { path: paid, headers: { host, "sec-fetch-site": "same-origin" } },
      { path: paid, headers: { host: "evil.example" } }, // DNS rebinding: the page's own name resolves to loopback
      { path: paid, headers: { host: `evil.example:${port}` } },
      { path: paid, headers: { host: "127.0.0.1" } },
      { path: "/mandate/kill", method: "POST", headers: { host, origin: "https://evil.example" } },
      { path: "/mandate/status", headers: { host: `attacker.test:${port}` } },
      { path: "/mcp", method: "POST", headers: { host, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" },
    ];
    for (const attempt of attempts) {
      const resp = await raw(port, attempt);
      assert.equal(resp.status, 403, JSON.stringify(attempt));
      assert.match(JSON.parse(resp.text).error, /host_not_allowed|browser_origin_not_allowed/);
    }
    assert.equal(s.payer.signatures, 0);
    assert.equal(s.world.hits.length, 0, "a refused browser request reached the seller");
    assert.equal(s.runtime.status().halt.active, false, "a page killed the sidecar");
    // The same requests from a local client are served.
    for (const good of [host, `localhost:${port}`]) {
      assert.equal((await raw(port, { path: "/health", headers: { host: good } })).status, 200);
    }
  } finally {
    await s.close();
  }
});

test("as HTTP_PROXY: an http target is governed like /pay, and CONNECT is refused and logged", async () => {
  const s = await makeSidecar();
  try {
    const port = s.sidecar.port;
    const target = s.world.url("ok");
    const paid = await raw(port, { path: target, headers: { host: new URL(target).host } });
    assert.equal(paid.status, 200);
    assert.equal(paid.headers["x-twzrd-mandate"], "settled");
    assert.equal(JSON.parse(paid.text).answer, 42);
    assert.equal(s.payer.signatures, 1);
    const refused = await raw(port, { path: "http://example.invalid/x", headers: { host: "example.invalid" } });
    assert.equal(refused.status, 403);
    assert.equal(JSON.parse(refused.text).error.code, "tool_not_allowed");
    const tunnel = await raw(port, { method: "CONNECT", path: "api.openai.com:443" });
    assert.equal(tunnel.status, 403);
    const last = s.runtime.ledger.tail(1)[0];
    assert.deepEqual([last.outcome, last.code], ["refused", "connect_not_supported"]);
  } finally {
    await s.close();
  }
});

test("/v1 without a meter forwards nothing; without the inference tool it is refused", async () => {
  const s = await makeSidecar();
  try {
    const resp = await s.get("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(resp.status, 503);
    assert.equal((await resp.json()).error.code, "inference_not_configured");
  } finally {
    await s.close();
  }
  const denied = await makeSidecar({ mandate: { allowedTools: ["mcp:echo"] } });
  try {
    const resp = await denied.get("/v1/chat/completions", { method: "POST", body: "{}" });
    assert.equal(resp.status, 403);
    assert.equal((await resp.json()).error.code, "tool_not_allowed");
  } finally {
    await denied.close();
  }
  const none = await makeSidecar({ mcp: false });
  try {
    assert.equal((await none.get("/mcp", rpc(1, "tools/list"))).status, 503);
  } finally {
    await none.close();
  }
});

test("MCP proxy: list and free calls pass, a paid tool settles in band with one signature", async () => {
  const s = await makeSidecar();
  try {
    const init = await (await s.get("/mcp", rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }))).json();
    assert.equal(init.result.serverInfo.name, "loopback-mcp");
    const list = await (await s.get("/mcp", rpc(2, "tools/list"))).json();
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["echo", "paid_lookup", "unlisted_tool"]);
    const echo = await (await s.get("/mcp", rpc(3, "tools/call", { name: "echo", arguments: { text: "hi" } }))).json();
    assert.equal(echo.id, 3);
    assert.equal(echo.result.isError ?? false, false);
    assert.equal(s.payer.signatures, 0);

    const paid = await (await s.get("/mcp", rpc(4, "tools/call", { name: "paid_lookup", arguments: {} }))).json();
    assert.equal(paid.id, 4);
    assert.equal(paid.result.isError ?? false, false, JSON.stringify(paid));
    assert.equal(paid.result.structuredContent.answer, 42);
    assert.deepEqual([s.payer.signatures, s.world.paidCount], [1, 1]);
    const rows = s.runtime.ledger.tail(2);
    assert.deepEqual(rows.map((r) => [r.tool, r.outcome]), [["mcp:echo", "free"], ["mcp:paid_lookup", "settled"]]);
    assert.deepEqual([rows[1].receipt, rows[1].inclusion, rows[1].signatures, rows[1].settledUsd], ["verified", "proven", 1, "0.01"]);
  } finally {
    await s.close();
  }
});

test("MCP proxy: refusals come back as tool errors naming the layer, with nothing signed", async () => {
  const s = await makeSidecar();
  try {
    const unlisted = await (await s.get("/mcp", rpc(1, "tools/call", { name: "unlisted_tool", arguments: {} }))).json();
    assert.equal(unlisted.result.isError, true);
    assert.deepEqual([unlisted.result.structuredContent.twzrd_mandate.code, unlisted.result.structuredContent.twzrd_mandate.layer], ["tool_not_allowed", 3]);
    assert.equal(s.world.hits.length, 0, "a tool off the allow-list reached the MCP server");

    s.world.product("mcp").priceMicro = 70_000;
    const dear = await (await s.get("/mcp", rpc(2, "tools/call", { name: "paid_lookup", arguments: {} }))).json();
    assert.deepEqual([dear.result.isError, dear.result.structuredContent.twzrd_mandate.code], [true, "per_request_cap"]);

    s.world.product("mcp").priceMicro = 10_000;
    s.world.product("mcp").payTo = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const wash = await (await s.get("/mcp", rpc(3, "tools/call", { name: "paid_lookup", arguments: {} }))).json();
    assert.deepEqual([wash.result.isError, wash.result.structuredContent.twzrd_mandate.code, wash.result.structuredContent.twzrd_mandate.signatures], [true, "trust_gate_refused", 0]);

    // The agent cannot hand the proxy a payment to forward, or hide a call in a batch.
    const own = await (await s.get("/mcp", rpc(4, "tools/call", { name: "paid_lookup", arguments: {}, _meta: { "x402/payment": { forged: true } } }))).json();
    assert.equal(own.error.code, -32602);
    const batch = await s.get("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "paid_lookup" } }]),
    });
    assert.equal((await batch.json())[0].error.code, -32600);
    assert.deepEqual([s.payer.signatures, s.world.paidCount], [0, 0]);

    s.runtime.kill("test");
    const halted = await (await s.get("/mcp", rpc(6, "tools/list"))).json();
    assert.equal(halted.error.data.twzrd_mandate.code, "kill_switch");
  } finally {
    await s.close();
  }
});

test("MCP over stdio: the same gateway serves newline-delimited JSON-RPC", async () => {
  const rig = await makeRig();
  const gateway = createMcpGateway(rig.runtime, createHttpUpstream(rig.world.mcpUrl, { fetch: rig.guard.fetch }));
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = [];
    let buffer = "";
    output.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
      }
    });
    const done = runMcpStdio(gateway, { input, output });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write("this is not json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "paid_lookup", arguments: {} } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unlisted_tool", arguments: {} } })}\n`);
    input.end();
    await done;
    const byId = Object.fromEntries(lines.filter((l) => l.id !== undefined && l.id !== null).map((l) => [l.id, l]));
    assert.equal(byId[1].result.tools.length, 3);
    assert.equal(byId[2].result.structuredContent.answer, 42);
    assert.equal(byId[3].result.structuredContent.twzrd_mandate.code, "tool_not_allowed");
    assert.ok(lines.some((l) => l.error?.code === -32700), "a line that is not JSON gets a parse error");
    assert.equal(rig.payer.signatures, 1);
  } finally {
    gateway.close();
    await rig.close();
  }
});

test("heartbeat: signed by the agent, chained, bound to the ledger head, tamper-evident", async () => {
  const s = await makeSidecar();
  try {
    assert.equal((await s.get("/mandate/heartbeat")).status, 404);
    assert.equal((await s.get("/mandate/heartbeat", { method: "POST" })).status, 401);
    await s.get(`/pay/${s.world.url("ok")}`);
    await s.get("/pay/http://127.0.0.1:9/x");
    const auth = { authorization: `Bearer ${s.sidecar.controlToken}` };
    const first = await (await s.get("/mandate/heartbeat", { method: "POST", headers: auth })).json();
    assert.equal(first.schema, "twzrd.mandate.heartbeat.v1");
    assert.deepEqual([first.seq, first.decisions, first.refusals, first.settledUsd, first.prevHeartbeatHash], [1, 2, 1, "0.01", "genesis"]);
    assert.deepEqual(first.remainingBudgetUsd, { hour: "0.99", day: "0.99" });
    assert.equal(first.ledgerHeadHash, s.runtime.ledger.head());
    assert.deepEqual([first.agent, first.signature.publicKey, first.mandateId], [s.agentKey.publicKey, s.agentKey.publicKey, s.mandate.mandateId]);
    assert.deepEqual(verifyHeartbeat(first, { agent: s.agentKey.publicKey }), { ok: true });

    const second = emitHeartbeat(s.runtime);
    assert.deepEqual([second.seq, second.prevHeartbeatHash], [2, heartbeatHash(first)]);
    assert.deepEqual(lastHeartbeat(s.stateDir), second);
    assert.equal(fs.readFileSync(path.join(s.stateDir, HEARTBEAT_LOG), "utf8").trim().split("\n").length, 2);
    assert.deepEqual(await (await s.get("/mandate/heartbeat")).json(), second);

    for (const edit of [(h) => (h.settledUsd = "0"), (h) => (h.refusals = 0), (h) => (h.ledgerHeadHash = "0".repeat(64)), (h) => (h.remainingBudgetUsd.day = "5.00"), (h) => (h.seq = 9)]) {
      const copy = JSON.parse(JSON.stringify(first));
      edit(copy);
      assert.equal(verifyHeartbeat(copy).ok, false, `${edit}`);
    }
    assert.equal(verifyHeartbeat(first, { agent: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }).ok, false);
    for (const bad of [null, {}, "x", { ...first, signature: undefined }]) assert.equal(verifyHeartbeat(bad).ok, false);
  } finally {
    await s.close();
  }
});
