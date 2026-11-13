import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HttpError,
  RedirectRefusedError,
  fetchConsistencyProof,
  fetchInclusionProof,
  fetchLogDescriptor,
  fetchSth,
} from "../src/client.js";
import type { FetchLike } from "../src/util.js";

/*
 * A log is the party being checked, so its answers do not get to choose where
 * the verifier's requests go. Over real sockets: a log that answers every
 * route with a redirect to another server, and that other server (the canary)
 * counting what reaches it. The canary stands in for anything the verifier's
 * host can reach and the log cannot: loopback, a private network, a cloud
 * metadata endpoint.
 */

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

let log: http.Server;
let canary: http.Server;
let logUrl: string;
let stateDir: string;
const canaryHits: string[] = [];

const listen = (server: http.Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)),
  );

before(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "twzrd-redirect-"));
  canary = http.createServer((req, res) => {
    canaryHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    // Shaped so that every helper would accept it if it arrived.
    res.end(
      JSON.stringify({
        version: 1,
        log_id: "internal-service",
        secret: "INTERNAL-ONLY",
        tree_size: 1,
        root: "ab".repeat(32),
        leaf_index: 0,
        audit_path: [],
        path: [],
      }),
    );
  });
  const canaryUrl = await listen(canary);
  log = http.createServer((req, res) => {
    const status = Number(new URL(req.url ?? "/", "http://x").searchParams.get("status")) || 302;
    res.writeHead(status, { location: `${canaryUrl}/canary` });
    res.end();
  });
  logUrl = await listen(log);
});

after(async () => {
  await new Promise<void>((resolve) => log.close(() => resolve()));
  await new Promise<void>((resolve) => canary.close(() => resolve()));
  rmSync(stateDir, { recursive: true, force: true });
});

const LEAF = "11".repeat(32);

const helpers: Array<[string, () => Promise<unknown>]> = [
  ["descriptor", () => fetchLogDescriptor(logUrl)],
  ["sth", () => fetchSth(logUrl)],
  ["inclusion proof", () => fetchInclusionProof(logUrl, LEAF)],
  ["consistency proof", () => fetchConsistencyProof(logUrl, 1, 2)],
];

for (const [name, call] of helpers) {
  test(`a redirected ${name} request is refused and never reaches the redirect target`, async () => {
    canaryHits.length = 0;
    await assert.rejects(call, (e: unknown) => {
      assert.ok(e instanceof RedirectRefusedError, String(e));
      assert.ok(e instanceof HttpError);
      assert.equal(e.status, 302);
      assert.match(e.message, /redirect not followed/);
      return true;
    });
    assert.deepEqual(canaryHits, []);
  });
}

test("every redirect status is refused", async () => {
  for (const status of [301, 303, 307, 308]) {
    canaryHits.length = 0;
    const endpoints = { sth: `/v1/log/sth?status=${status}` };
    await assert.rejects(
      () => fetchSth(logUrl, { descriptor: { version: 1, log_id: "x", endpoints } }),
      (e: unknown) => e instanceof RedirectRefusedError && e.status === status,
    );
    assert.deepEqual(canaryHits, [], String(status));
  }
});

test("a fetch that followed the redirect anyway does not get its answer accepted", async () => {
  // A caller-supplied fetch may ignore `redirect: "manual"`. It reports that it
  // followed, and the body it brings back is not the log's.
  let asked: string | undefined;
  const following: FetchLike = async (_url, init) => {
    asked = init?.redirect;
    return Object.assign(
      { ok: true, status: 200, json: async () => ({ version: 1, log_id: "internal-service" }) },
      { redirected: true },
    );
  };
  await assert.rejects(() => fetchLogDescriptor("https://log.example", following), RedirectRefusedError);
  assert.equal(asked, "manual");

  const direct: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ version: 1, log_id: "log.example/v6" }) });
  assert.equal((await fetchLogDescriptor("https://log.example", direct)).log_id, "log.example/v6");
});

test("monitor does not follow a log's redirect", async () => {
  canaryHits.length = 0;
  const res = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      process.execPath,
      [CLI, "monitor", "--base-url", logUrl, "--state", join(stateDir, "pin.json")],
      {
        env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
        timeout: 30_000,
      },
      (err, stdout, stderr) => resolve({ code: err ? 1 : 0, out: `${stdout}${stderr}` }),
    );
  });
  assert.notEqual(res.code, 0, res.out);
  assert.deepEqual(canaryHits, []);
  assert.doesNotMatch(res.out, /abababab|INTERNAL-ONLY/);
});
