import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ACTS, HALTED_CALLS_PER_RAIL, SCHEMA, SEATS, SEAT_RAILS, ShowcaseRefusal, TRACE_SCHEMA, runShowcase } from "../lib/acts.mjs";
import { X402_SOLANA_PACKAGES, X402_SOLANA_SETUP, loadX402Solana } from "../lib/agent.mjs";
import { createKillSwitch } from "../lib/kill-switch.mjs";
import { installNetGuard } from "../lib/net-guard.mjs";
import { RAIL_IDS, RAILS, demoAddress } from "../lib/rails.mjs";

// The x402-solana seat is opt-in (npm run setup:x402-solana). These tests run
// either way and check the seats that ran, and the skipped one when it is.
const SOLANA_INSTALLED = (await loadX402Solana()).available;
const RUN_SEATS = SOLANA_INSTALLED ? [...SEATS] : SEATS.filter((seat) => seat !== "x402-solana");
/** Checks in a full run: 58 with all three seats, 45 without x402-solana. */
const FULL_RUN_CHECKS = SOLANA_INSTALLED ? 58 : 45;

const SHOWCASE = fileURLToPath(new URL("../showcase.mjs", import.meta.url));
const runCli = (args, input) =>
  spawnSync(process.execPath, [SHOWCASE, ...args], { encoding: "utf8", timeout: 60_000, input: input ?? "" });

const scratchDirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "x402-guard-showcase-"));
  scratchDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const row = (p, keys) => keys.map((k) => p[k]);

test("all three acts pass on every seat that runs and each of its rails, loopback only", async () => {
  const dir = scratch();
  const t = await runShowcase({ dataDir: dir });
  const failed = t.checks.filter((c) => !c.pass);
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
  assert.equal(t.result, "pass");
  assert.equal(t.schema, SCHEMA);
  assert.deepEqual(t.actsRun, [...ACTS]);
  assert.equal(t.checks.length, FULL_RUN_CHECKS);
  assert.deepEqual(SEATS, ["safe-fetch", "x402-fetch", "x402-solana"]);
  assert.deepEqual(SEAT_RAILS, { "safe-fetch": RAIL_IDS, "x402-fetch": RAIL_IDS, "x402-solana": ["solana"] });
  assert.deepEqual(t.seats, RUN_SEATS);
  assert.deepEqual(t.seatRails, Object.fromEntries(RUN_SEATS.map((seat) => [seat, [...SEAT_RAILS[seat]]])));
  if (SOLANA_INSTALLED) {
    assert.deepEqual(t.skippedSeats, []);
    assert.match(t.rpc.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } else {
    assert.deepEqual(
      t.skippedSeats.map((s) => [s.seat, s.reason, s.setup]),
      [["x402-solana", "not_installed", X402_SOLANA_SETUP]],
    );
    assert.ok(t.skippedSeats[0].missing.length > 0 && t.skippedSeats[0].missing.every((name) => X402_SOLANA_PACKAGES.includes(name)));
    assert.equal(t.rpc, null);
  }
  const solana = (p) => p.seat === "x402-solana";

  const { allow, block, kill } = t.acts;
  const KEYS = ["seat", "rail", "shop", "decision", "stage", "signerInvocations", "sellerPaid", "status", "receiptVerified"];
  assert.deepEqual(
    allow.purchases.map((p) => row(p, KEYS)),
    RUN_SEATS.flatMap((seat) =>
      SEAT_RAILS[seat].flatMap((id) => [
        [seat, id, "/good", "allow", "pre_sign", 1, 1, 200, null],
        [seat, id, "/receipt", "allow", "pre_sign", 1, 1, 200, true],
      ]),
    ),
  );
  for (const p of allow.purchases) {
    assert.deepEqual(row(p, ["chain", "asset", "amountUsdc"]), [p.rail, "USDC", "0.01"]);
    assert.equal(p.payTo, RAILS[p.rail].sellers.good);
    // x402-solana read the chain and handed its wallet a transfer that pays the offer; no other seat reads the chain.
    assert.deepEqual(
      [p.rpcCalls > 0, p.signedTransferMatchesOffer],
      solana(p) ? [true, true] : [false, null],
      `${p.seat} ${p.rail} ${p.shop}`,
    );
  }
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
  assert.equal(allow.receipt.connectionsDuringCheck, 0);

  const gateReasons = ["unauthorized_recipient", "price_cap_exceeded", "unsupported_or_non_usdc_asset"];
  const reasons = {
    "safe-fetch": ["intel_block", "over_max_spend", "non_usdc_asset"],
    "x402-fetch": gateReasons,
    "x402-solana": gateReasons,
  };
  assert.deepEqual(
    block.purchases.map((p) => row(p, ["seat", "rail", "shop", "reason"])),
    RUN_SEATS.flatMap((seat) =>
      SEAT_RAILS[seat].flatMap((id) => ["/flagged", "/pricey", "/wrong-asset"].map((shop, i) => [seat, id, shop, reasons[seat][i]])),
    ),
  );
  for (const p of block.purchases) {
    assert.deepEqual(row(p, ["decision", "stage", "signerInvocations", "demoSignerCalls", "sellerPaid", "sellerUnpaid"]), [
      "block",
      "pre_sign",
      0,
      0,
      0,
      1,
    ]);
    // x402-solana refused before it read the chain.
    assert.equal(p.rpcCalls, solana(p) ? 0 : null);
  }
  assert.deepEqual(
    block.purchases.filter((p) => p.shop === "/wrong-asset").map((p) => [p.asset, p.amountUsdc]),
    RUN_SEATS.flatMap((seat) => SEAT_RAILS[seat].map(() => ["non-USDC", null])),
  );
  assert.equal(block.safeFetchBudgetSpentByRefusalsUsdc, "0.00");

  assert.equal(kill.inFlight.length, RUN_SEATS.reduce((n, seat) => n + SEAT_RAILS[seat].length, 0));
  for (const p of kill.inFlight) {
    assert.deepEqual(row(p, ["decision", "reason", "stage", "signerInvocations", "sellerPaid", "sellerUnpaid"]), [
      "block",
      "twzrd_kill_switch",
      "pre_sign",
      0,
      0,
      1,
    ]);
    assert.equal(typeof p.killLatencyMs, "number");
    // The x402-solana purchase was past its hook (it had read the chain) when .kill was written.
    if (solana(p)) assert.ok(p.rpcCalls > 0, `rpcCalls ${p.rpcCalls}`);
  }
  for (const h of kill.halted) {
    assert.equal(h.refusedOnEntry, HALTED_CALLS_PER_RAIL);
    assert.equal(h.sellerRequests, 0);
    assert.equal(h.demoSignerCalls, 0);
    assert.equal(h.rpcCalls, h.seat === "x402-solana" ? 0 : null);
  }
  assert.equal(kill.killRemoved, true);
  assert.ok(kill.resumed.every((p) => p.decision === "allow" && p.signerInvocations === 1 && p.sellerPaid === 1));

  assert.deepEqual(Object.keys(t.totals.seats), RUN_SEATS);
  for (const seat of RUN_SEATS) {
    const s = t.totals.seats[seat];
    const rails = SEAT_RAILS[seat];
    const purchases = rails.length * (2 + 3 + 1 + HALTED_CALLS_PER_RAIL + 1);
    assert.equal(s.purchases, purchases);
    const paid = rails.length * 3;
    assert.deepEqual([s.demoSignerCalls, s.signerInvocations, s.sellerPaid], [paid, paid, paid], seat);
    assert.deepEqual(s.sellerPaidByRail, Object.fromEntries(rails.map((id) => [id, 3])));
    assert.deepEqual(s.events, {
      onDecision: purchases,
      onKill: rails.length * (1 + HALTED_CALLS_PER_RAIL),
      onReceiptVerified: rails.length,
    });
  }
  assert.equal(t.totals.seats["safe-fetch"].ledgerBudgetUsedUsdc, "0.06");
  assert.deepEqual(t.totals.seats["x402-fetch"].budgetUsedUsdc, { base: "0.03", solana: "0.03" });
  if (SOLANA_INSTALLED) {
    assert.deepEqual(t.totals.seats["x402-solana"].budgetUsedUsdc, { solana: "0.03" });
    assert.deepEqual(t.totals.seats["x402-solana"].signedTransfers, { handed: 3, matchingOffer: 3 });
    // One blockhash read per transaction built (three paid, one refused in its
    // wallet during the kill act), with the mint twice and two token accounts.
    const r = t.totals.solanaRpc;
    assert.deepEqual([r.getLatestBlockhash, r.getAccountInfo, r.other], [4, 16, 0]);
  } else {
    assert.equal(t.totals.solanaRpc, undefined, "no RPC stub runs without the x402-solana seat");
    assert.ok(t.checks.every((c) => !c.id.includes("x402-solana") && !c.id.includes("solana_rpc")));
  }
  assert.equal(t.totals.nonLoopbackConnectionsRefused, 0);
  assert.ok(t.totals.tcpConnections > 0, "the guard saw the loopback connections");
  assert.equal(existsSync(join(dir, ".kill")), false, "the run removed the .kill it wrote");
  assert.equal(existsSync(join(dir, ".pause")), false, "no refusal wrote a .pause");
  assert.deepEqual(readdirSync(dir), [], "the run left nothing in the data dir");
});

test("the trace has one decision record per purchase, in order, with the fields a harness reads", async () => {
  const seen = [];
  const t = await runShowcase({ dataDir: scratch(), acts: ["block"], onEvent: (r) => seen.push(r) });
  assert.deepEqual(seen, t.trace);
  assert.equal(seen[0].type, "start");
  assert.equal(seen[0].schema, TRACE_SCHEMA);
  assert.deepEqual(seen[0].acts, ["block"]);
  assert.deepEqual(seen[0].seats, RUN_SEATS);
  assert.deepEqual(seen[0].skippedSeats, t.skippedSeats);
  assert.equal(seen[0].packages["x402-solana"] !== null, SOLANA_INSTALLED);
  assert.deepEqual(seen.at(-1), { type: "result", result: "pass", passed: t.checks.length, total: t.checks.length, failed: [], actsRun: ["block"] });
  const decisions = seen.filter((r) => r.type === "decision");
  assert.equal(decisions.length, t.acts.block.purchases.length);
  for (const d of decisions) {
    for (const key of [
      "decision",
      "reason",
      "chain",
      "asset",
      "amountUsdc",
      "signerInvocations",
      "killLatencyMs",
      "receiptVerified",
      "rpcCalls",
      "signedTransferMatchesOffer",
    ]) {
      assert.ok(Object.hasOwn(d, key), `${key} in ${JSON.stringify(d)}`);
    }
  }
  assert.equal(t.acts.allow, undefined);
});

test("beforeAct can stop the run between acts", async () => {
  const asked = [];
  const t = await runShowcase({
    dataDir: scratch(),
    beforeAct: async (act) => {
      asked.push(act);
      return act === "allow";
    },
  });
  assert.deepEqual(asked, ["allow", "block"]);
  assert.deepEqual(t.actsRun, ["allow"]);
  assert.equal(t.result, "stopped");
  assert.deepEqual(t.checks.filter((c) => !c.pass), []);
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
  const run = runCli(["--data-dir", dir]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ACT 1 {2}ALLOW$/m);
  assert.match(run.stdout, /^ACT 3 {2}KILL /m);
  assert.match(run.stdout, new RegExp(`RESULT {2}PASS {2}${FULL_RUN_CHECKS}/${FULL_RUN_CHECKS} checks`));
  if (SOLANA_INSTALLED) {
    assert.match(run.stdout, /^rpc {5}http:\/\/127\.0\.0\.1:\d+ /m);
    assert.match(run.stdout, /^ {8}x402-solana {2}createGuardedX402SolanaFetch /m);
  } else {
    // The header and the result each name the skipped seat and the command that adds it.
    const skipped = /^ {2}(?: {6})?x402-solana {2}not installed: npm run setup:x402-solana adds this seat$/gm;
    assert.equal(run.stdout.match(skipped)?.length, 2, run.stdout);
    assert.doesNotMatch(run.stdout, /^rpc /m);
  }
  const t = JSON.parse(readFileSync(join(dir, "showcase-transcript.json"), "utf8"));
  assert.equal(t.schema, SCHEMA);
  assert.equal(t.result, "pass");
  assert.deepEqual(readdirSync(dir), ["showcase-transcript.json"], "the transcript is the only file the run leaves");

  writeFileSync(join(dir, ".kill"), "halt\n");
  const refused = runCli(["--data-dir", dir]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refused to start/);
  assert.equal(readFileSync(join(dir, ".kill"), "utf8"), "halt\n");
});

test("--json prints the trace as one JSON record per line, for the selected act only", () => {
  const dir = scratch();
  const run = runCli(["--scenario", "kill", "--json", "--data-dir", dir]);
  assert.equal(run.status, 0, run.stderr);
  const records = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records[0].type, "start");
  assert.deepEqual(records[0].acts, ["kill"]);
  assert.equal(records.at(-1).type, "result");
  assert.equal(records.at(-1).result, "pass");
  const decisions = records.filter((r) => r.type === "decision");
  assert.ok(decisions.length > 0 && decisions.every((d) => d.act === "kill"));
  assert.ok(decisions.filter((d) => d.step === "in_flight").every((d) => typeof d.killLatencyMs === "number"));
  assert.deepEqual(
    records.filter((r) => r.type === "kill_switch").map((r) => r.action),
    ["engaged", "removed"],
  );
  assert.match(run.stderr, /^transcript /m);
  const t = JSON.parse(readFileSync(join(dir, "showcase-transcript.json"), "utf8"));
  assert.deepEqual(t.trace, records);
});

test("--interactive runs an act on Enter and stops on q, exiting 0", () => {
  const run = runCli(["--interactive", "--data-dir", scratch()], "\nq\n");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ACT 1 {2}ALLOW$/m);
  assert.doesNotMatch(run.stdout, /^ACT 2/m);
  assert.match(run.stdout, /RESULT {2}STOPPED {2}(\d+)\/\1 checks \(stopped; ran: allow\)/);
  assert.match(run.stderr, /next: ACT 2 BLOCK/);

  const eof = runCli(["--interactive", "--scenario", "block", "--data-dir", scratch()]);
  assert.equal(eof.status, 0, eof.stderr);
  assert.match(eof.stdout, /RESULT {2}STOPPED .*ran: none/);
});

test("--interactive exits after the last act while stdin is still open, as a terminal's is", async () => {
  const child = spawn(process.execPath, [SHOWCASE, "--interactive", "--scenario", "allow", "--data-dir", scratch()], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stdin.write("\n"); // answer the one prompt, and never end stdin
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("still running 30 s later");
    }, 30_000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  assert.equal(code, 0);
  assert.match(stdout, /RESULT {2}PASS {2}(\d+)\/\1 checks/);
});

test("the CLI refuses an unknown flag, a positional argument and an unknown scenario with exit 2", () => {
  for (const args of [["--bogus"], ["extra"], ["--scenario", "nope"], ["--scenario"]]) {
    const run = runCli(args);
    assert.equal(run.status, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, /^usage: node showcase\.mjs/m);
  }
});
