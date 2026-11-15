import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { HALTED_CALLS_PER_RAIL, SCHEMA, ShowcaseRefusal, runShowcase } from "../lib/acts.mjs";
import { createKillSwitch } from "../lib/kill-switch.mjs";
import { installNetGuard } from "../lib/net-guard.mjs";
import { RAIL_IDS, RAILS, demoAddress } from "../lib/rails.mjs";

const SHOWCASE = fileURLToPath(new URL("../showcase.mjs", import.meta.url));

const scratchDirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "x402-guard-showcase-"));
  scratchDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

test("all three acts pass on both rails, loopback only", async () => {
  const dir = scratch();
  const t = await runShowcase({ dataDir: dir });
  const failed = t.checks.filter((c) => !c.pass);
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
  assert.equal(t.result, "pass");
  assert.equal(t.schema, SCHEMA);

  const { allow, block, kill } = t.acts;
  assert.deepEqual(
    allow.purchases.map((p) => [p.rail, p.verdict, p.signer_invocations, p.seller_paid, p.status]),
    RAIL_IDS.map((id) => [id, "allow", 1, 1, 200]),
  );
  assert.deepEqual(
    allow.receipt.cases.map((c) => [c.name, c.valid]),
    [
      ["as_issued", true],
      ["score_plus_1", false],
      ["fresh_for_30_more_days", false],
    ],
  );
  for (const c of allow.receipt.cases.slice(1)) {
    assert.ok(c.errors.some((e) => e.startsWith("leaf mismatch")), `${c.name}: ${c.errors.join("; ")}`);
  }
  assert.equal(allow.receipt.connections_during_check, 0);

  assert.deepEqual(
    block.purchases.map((p) => [p.rail, p.path, p.reason]),
    RAIL_IDS.flatMap((id) => [
      [id, "/flagged", "intel_block"],
      [id, "/pricey", "over_max_spend"],
      [id, "/wrong-asset", "non_usdc_asset"],
    ]),
  );
  for (const p of block.purchases) {
    assert.equal(p.signer_invocations, 0);
    assert.equal(p.demo_signer_calls, 0);
    assert.equal(p.seller_paid, 0);
  }
  assert.equal(block.budget_spent_by_refusals_usdc, "0.00");

  for (const e of kill.in_flight) {
    assert.equal(e.reason, "twzrd_kill_switch");
    assert.equal(e.signer_invocations, 0);
    assert.equal(e.seller_paid, 0);
  }
  assert.equal(kill.in_flight_seller_402s, RAIL_IDS.length, "both purchases had fetched their 402 before the kill");
  for (const h of kill.halted) {
    assert.equal(h.refused_on_entry, HALTED_CALLS_PER_RAIL);
    assert.equal(h.seller_requests, 0);
    assert.equal(h.demo_signer_calls, 0);
  }
  assert.equal(kill.kill_removed, true);
  assert.ok(kill.resumed.every((p) => p.verdict === "allow" && p.signer_invocations === 1));

  assert.equal(t.totals.demo_signer_calls, 2 * RAIL_IDS.length);
  assert.equal(t.totals.gate_signer_invocations, 2 * RAIL_IDS.length);
  assert.equal(t.totals.seller_paid, 2 * RAIL_IDS.length);
  assert.equal(t.totals.budget_used_usdc, "0.04");
  assert.equal(t.totals.non_loopback_connections_refused, 0);
  assert.ok(t.totals.tcp_connections > 0, "the guard saw the loopback connections");
  assert.equal(existsSync(join(dir, ".kill")), false, "the run removed the .kill it wrote");
  assert.equal(existsSync(join(dir, ".pause")), false, "no refusal wrote a .pause");
});

test("refuses to start over an existing .kill and leaves it in place", async () => {
  const dir = scratch();
  writeFileSync(join(dir, ".kill"), "operator halt\n");
  await assert.rejects(runShowcase({ dataDir: dir }), ShowcaseRefusal);
  assert.equal(readFileSync(join(dir, ".kill"), "utf8"), "operator halt\n");
});

test("refuses to start over an existing .pause and leaves it in place", async () => {
  const dir = scratch();
  writeFileSync(join(dir, ".pause"), '{"until_unix_ms":1}\n');
  await assert.rejects(runShowcase({ dataDir: dir }), ShowcaseRefusal);
  assert.equal(readFileSync(join(dir, ".pause"), "utf8"), '{"until_unix_ms":1}\n');
});

test("gate settings in the environment are neither read nor written", async () => {
  const foreign = scratch();
  writeFileSync(join(foreign, ".kill"), "another agent's halt\n");
  const settings = {
    TWZRD_STATE_DIR: foreign,
    KILLSWITCH_KILL_FILE: join(foreign, ".kill"),
    KILLSWITCH_PAUSE_FILE: join(foreign, ".pause"),
    TWZRD_SPEND_LEDGER_FILE: join(foreign, "spend-ledger.jsonl"),
    TWZRD_SVM_WAL_FILE: join(foreign, "svm-wal.jsonl"),
    TWZRD_TRIP_PAUSE_ON_BLOCK_MS: "60000",
  };
  const saved = Object.fromEntries(Object.keys(settings).map((k) => [k, process.env[k]]));
  Object.assign(process.env, settings);
  try {
    const t = await runShowcase({ dataDir: scratch() });
    assert.equal(t.result, "pass", JSON.stringify(t.checks.filter((c) => !c.pass)));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(readFileSync(join(foreign, ".kill"), "utf8"), "another agent's halt\n");
  assert.deepEqual(readdirSync(foreign), [".kill"]);
});

test("demo seller addresses are sha256 digests of public labels", () => {
  for (const id of RAIL_IDS) {
    for (const seller of ["good", "flagged"]) assert.equal(RAILS[id].sellers[seller], demoAddress(seller, id));
  }
  assert.match(RAILS.base.sellers.good, /^0x[0-9a-f]{40}$/);
  assert.match(RAILS.solana.sellers.good, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

test("the net guard refuses a connection that is not loopback, before it is made", async () => {
  const guard = installNetGuard();
  const connectError = (options) =>
    new Promise((resolve) => {
      const socket = net.connect(options);
      socket.once("error", resolve);
      socket.once("connect", () => resolve(new Error("connected")));
    });
  try {
    // 192.0.2.0/24 is reserved for documentation and never routed.
    assert.equal((await connectError({ host: "192.0.2.1", port: 9 })).code, "ERR_SHOWCASE_LOOPBACK_ONLY");
    await assert.rejects(
      fetch("http://192.0.2.1/", { signal: AbortSignal.timeout(5000) }),
      (e) => e.cause?.code === "ERR_SHOWCASE_LOOPBACK_ONLY",
    );
    // A hostname is refused before it is resolved, localhost included, and so
    // is a local socket path: only literal 127.0.0.1 and ::1 pass.
    assert.equal((await connectError({ host: "localhost", port: 9 })).code, "ERR_SHOWCASE_LOOPBACK_ONLY");
    assert.equal((await connectError({ path: join(tmpdir(), "no-such.sock") })).code, "ERR_SHOWCASE_LOOPBACK_ONLY");
    assert.equal(guard.stats.refused, 4);
    assert.equal(guard.stats.connections, 0);
  } finally {
    guard.uninstall();
  }
});

test("the kill switch removes only a .kill it wrote", () => {
  const dir = scratch();
  const mine = createKillSwitch(dir);
  const theirs = createKillSwitch(dir);
  mine.engage();
  assert.throws(() => theirs.engage(), { code: "EEXIST" });
  assert.throws(() => theirs.disengage(), ShowcaseRefusal);
  theirs.disengageIfOurs();
  assert.ok(existsSync(mine.file));
  assert.equal(mine.disengage(), true);
  assert.equal(existsSync(mine.file), false);
  assert.equal(mine.disengage(), false);
});

test("the CLI exits 0 and writes the transcript, and exits 2 when it refuses to start", () => {
  const dir = scratch();
  const run = spawnSync(process.execPath, [SHOWCASE, "--data-dir", dir], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /RESULT {2}PASS {2}(\d+)\/\1 checks/);
  const t = JSON.parse(readFileSync(join(dir, "showcase-transcript.json"), "utf8"));
  assert.equal(t.schema, SCHEMA);
  assert.equal(t.result, "pass");

  writeFileSync(join(dir, ".kill"), "halt\n");
  const refused = spawnSync(process.execPath, [SHOWCASE, "--data-dir", dir], { encoding: "utf8", timeout: 60_000 });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refused to start/);
  assert.equal(readFileSync(join(dir, ".kill"), "utf8"), "halt\n");
});
