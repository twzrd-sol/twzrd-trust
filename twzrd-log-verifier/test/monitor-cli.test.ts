import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { STH_DOMAIN_V2, signSth } from "../src/sth.js";
import { merkleRoot, consistencyProof } from "../src/merkle.js";
import { b58encode, bytesToHex } from "../src/util.js";

/*
 * End-to-end CLI coverage for `monitor`'s trust selection, over a real socket.
 *
 * Two behaviours regressed once and are pinned here:
 *  - with no key flags, monitor must use the built-in default pin, not fail
 *    with "no pinned key" and leave --trust-descriptor (TOFU) as the only
 *    zero-flag path;
 *  - the log descriptor must be read for its ENDPOINT paths even when the
 *    caller pins its own keys, or a log that publishes non-default paths is
 *    unreachable. Reading a log's routing is not trusting its identity.
 */

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const LOG_ID = "monitor-cli.local/v6";
const KEY_ID = "monitor-cli-ed25519-v1";
// Deliberately NOT the spec's default paths.
const ENDPOINTS = { sth: "/custom/head", consistency: "/custom/consistency" };

const kp = nacl.sign.keyPair();
const PUBKEY = b58encode(kp.publicKey);

const entries = Array.from({ length: 64 }, (_, i) => {
  const e = new Uint8Array(32);
  for (let j = 0; j < 32; j++) e[j] = (i * 29 + j * 7 + 11) & 0xff;
  return e;
});

let server: http.Server;
let baseUrl: string;
let stateDir: string;

const head = (size: number) =>
  signSth(
    {
      domain: STH_DOMAIN_V2,
      log_id: LOG_ID,
      key_id: KEY_ID,
      tree_size: size,
      timestamp_unix: 1_756_000_000,
      root: bytesToHex(merkleRoot(entries.slice(0, size))),
    },
    kp.secretKey,
  );

before(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "twzrd-monitor-"));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/twzrd-log") {
      return send({
        version: 1,
        log_id: LOG_ID,
        keys: [
          {
            key_id: KEY_ID,
            public_key: PUBKEY,
            mode: "sign",
            not_before_unix: 0,
            not_after_unix: null,
          },
        ],
        anchor_authority: "4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE",
        endpoints: ENDPOINTS,
      });
    }
    if (url.pathname === ENDPOINTS.sth) return send(head(50));
    if (url.pathname === ENDPOINTS.consistency) {
      const oldSize = Number(url.searchParams.get("old_size"));
      const newSize = Number(url.searchParams.get("new_size"));
      return send({
        path: consistencyProof(entries.slice(0, newSize), oldSize).map((b) => "0x" + bytesToHex(b)),
      });
    }
    // Anything at a DEFAULT path 404s: reaching the log at all proves the
    // descriptor's endpoints were honoured.
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(stateDir, { recursive: true, force: true });
});

let stateCounter = 0;
function freshState(): string {
  return join(stateDir, `pin-${stateCounter++}.json`);
}

function runCli(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
        timeout: 30_000,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

test("descriptor endpoints are honoured when the caller pins its own key", async () => {
  const res = await runCli([
    "monitor",
    "--base-url",
    baseUrl,
    "--state",
    freshState(),
    "--pubkey",
    PUBKEY,
  ]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /status\s+: pinned/);
  // The pin came from the caller, so this must not be labelled TOFU.
  assert.doesNotMatch(res.out, /TOFU/);
});

test("an explicit pin still wins when --trust-descriptor is also passed", async () => {
  const res = await runCli([
    "monitor",
    "--base-url",
    baseUrl,
    "--state",
    freshState(),
    "--pubkey",
    PUBKEY,
    "--trust-descriptor",
  ]);
  assert.equal(res.code, 0, res.out);
  assert.doesNotMatch(res.out, /TOFU/, "an explicit pin must never be downgraded to TOFU");
});

test("--trust-descriptor alone works and is labelled TOFU", async () => {
  const res = await runCli([
    "monitor",
    "--base-url",
    baseUrl,
    "--state",
    freshState(),
    "--trust-descriptor",
  ]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /TOFU/);
  assert.match(res.out, /status\s+: pinned/);
});

test("no key flags falls back to the built-in pin, not to TOFU and not to a config error", async () => {
  const res = await runCli(["monitor", "--base-url", baseUrl, "--state", freshState()]);
  // The built-in key is not this test log's key, so verification correctly
  // fails — but it must fail as a SIGNATURE mismatch, never as "no pinned key",
  // and must not silently fall back to trusting the log's own keys.
  assert.doesNotMatch(res.out, /no pinned key/);
  assert.doesNotMatch(res.out, /TOFU/);
  assert.match(res.out, /did not verify against the pinned key/);
  assert.equal(res.code, 1);
});

test("a pin flag with its value omitted is an argument error, not a silent fallback", async () => {
  // `--pubkey` with no value still counts as an explicit pin (so it suppresses
  // --trust-descriptor) while resolving to the built-in key, which would make a
  // typo read as a successful pin selection.
  for (const flag of ["--pubkey", "--keys"]) {
    const res = await runCli(["monitor", "--base-url", baseUrl, "--state", freshState(), flag]);
    assert.equal(res.code, 1, `${flag} without a value must fail: ${res.out}`);
    assert.match(res.out, new RegExp(`\\${flag} requires a value`));
    assert.doesNotMatch(res.out, /status\s+: pinned/, `${flag} must not report a successful pin`);
  }
});

test("a pin flag followed by another flag does not swallow it as the value", async () => {
  const res = await runCli([
    "monitor",
    "--base-url",
    baseUrl,
    "--state",
    freshState(),
    "--pubkey",
    "--trust-descriptor",
  ]);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /--pubkey requires a value/);
  // It must not quietly become a TOFU run either.
  assert.doesNotMatch(res.out, /TOFU/);
});

test("the pin advances across runs using the persisted state file", async () => {
  const state = freshState();
  const first = await runCli(["monitor", "--base-url", baseUrl, "--state", state, "--pubkey", PUBKEY]);
  assert.match(first.out, /status\s+: pinned/);
  const second = await runCli(["monitor", "--base-url", baseUrl, "--state", state, "--pubkey", PUBKEY]);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /status\s+: unchanged/);
});
