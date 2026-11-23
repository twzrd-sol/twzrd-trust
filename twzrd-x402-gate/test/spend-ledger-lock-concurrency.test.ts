import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createFileSpendLedger } from "../src/spend-ledger-file.js";

function runWorker(file: string, id: string): Promise<string> {
  const source = `
    import { createFileSpendLedger } from ${JSON.stringify(new URL("../src/spend-ledger-file.ts", import.meta.url).href)};
    const ledger = createFileSpendLedger(${JSON.stringify(file)});
    const ok = await ledger.reserveAsync("shared", 1n, ${JSON.stringify(id)}, 2n, 60_000, Date.now());
    if (ok) {
      await ledger.markSignedAsync(${JSON.stringify(id)});
      await ledger.commitAsync(${JSON.stringify(id)}, ${JSON.stringify(`tx-${id}`)});
    }
    process.stdout.write(ok ? "reserved" : "capped");
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(stdout) : reject(new Error(`worker ${id} exited ${code}: ${stderr}`)));
  });
}

test("multiple processes serialize stale-lock recovery and cannot reserve past a shared cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-lock-race-"));
  const file = join(dir, "spend.jsonl");
  // A pre-v2 interrupted direct-write lock is recoverable only after stale age.
  const lockPath = `${file}.lock`;
  writeFileSync(lockPath, '{"pid":', { mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  utimesSync(lockPath, old, old);

  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => runWorker(file, `hold-${i}`)));
  assert.equal(results.filter(result => result === "reserved").length, 2, results.join(","));
  assert.equal(results.filter(result => result === "capped").length, 4, results.join(","));
  assert.equal(createFileSpendLedger(file).spentMicro("shared", 60_000, Date.now()), 2n);
});


const tmpLedger = (tag: string) => join(mkdtempSync(join(tmpdir(), `twzrd-lock-${tag}-`)), "spend-v2.jsonl");
const age = (path: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(path, t, t); };
const lockAt = (file: string, record: Record<string, unknown>) => writeFileSync(`${file}.lock`, JSON.stringify(record), { mode: 0o600 });
/** The owner identity this process writes (hostname, plus PID namespace and boot id on Linux), read back from a row it wrote. */
const localIdentity = async (): Promise<string> => {
  const file = tmpLedger("identity");
  await createFileSpendLedger(file).reserveAsync("id", 0n, "id", undefined, 60_000, Date.now());
  return JSON.parse(readFileSync(file, "utf8").split("\n")[0]).hostname as string;
};
const deadPid = () => new Promise<number>((resolve, reject) => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  child.once("error", reject);
  child.once("exit", () => resolve(child.pid!));
});

test("a held lock makes the hold API wait without blocking the event loop, then reject", async () => {
  // Fresh unreadable lock: a write that may still be finishing. Not reaped.
  const fresh = tmpLedger("fresh");
  writeFileSync(`${fresh}.lock`, '{"pid":');
  // A remote host's lock: its pid cannot be checked, so it is live until 900 s old.
  const remote = tmpLedger("remote");
  lockAt(remote, { pid: 1, hostname: "another-host", acquiredAt: Date.now() - 60_000, token: "remote" });
  // A stale lock behind a reaper directory left by a crashed process.
  const stuck = tmpLedger("stuck");
  writeFileSync(`${stuck}.lock`, '{"pid":'); age(`${stuck}.lock`, 10_000);
  mkdirSync(`${stuck}.lock.reaper`); age(`${stuck}.lock.reaper`, 10_000);
  // Same hostname, another PID namespace or boot: its pid means nothing here, so
  // a "dead" pid does not make its lock stale; only 900 s of age would.
  const identity = await localIdentity();
  const otherNs = tmpLedger("other-ns");
  lockAt(otherNs, { pid: await deadPid(), hostname: hostname(), acquiredAt: Date.now() - 10_000, token: "other-ns" });

  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 50);
  const started = Date.now();
  try {
    const [a, b, c, d] = await Promise.allSettled([fresh, remote, stuck, otherNs].map(file => createFileSpendLedger(file).reserveAsync("s", 1n, "h", undefined, 60_000, Date.now())));
    for (const result of [a, b, c]) assert.equal(result.status, "rejected");
    if (identity !== hostname()) assert.equal(d.status, "rejected", "a lock from another PID namespace is not judged by pid");
    const reason = (r: PromiseSettledResult<boolean>) => String((r as PromiseRejectedResult).reason);
    assert.match(reason(a), /spend ledger lock timeout/);
    assert.doesNotMatch(reason(a), /reaper/, "no reaper hint when none is stuck");
    assert.match(reason(b), /spend ledger lock timeout/);
    assert.match(reason(c), /lock\.reaper.*remove it only when no process is using this ledger/, "a stuck reaper is named, not silently waited on");
  } finally { clearInterval(timer); }
  assert.ok(Date.now() - started >= 2_900, "waits about 3 s before rejecting");
  assert.ok(ticks >= 20, `the event loop kept running while waiting (${ticks} ticks)`);
  assert.ok(existsSync(`${fresh}.lock`) && existsSync(`${remote}.lock`), "live locks are left alone");
});

test("stale locks are reaped: a dead same-host pid, a remote lock past 900 s, an old unreadable lock", async () => {
  const dead = tmpLedger("dead");
  lockAt(dead, { pid: await deadPid(), hostname: await localIdentity(), acquiredAt: Date.now() - 10_000, token: "dead" });
  const remote = tmpLedger("remote-old");
  lockAt(remote, { pid: 1, hostname: "another-host", acquiredAt: Date.now() - 901_000, token: "old" });
  const torn = tmpLedger("torn");
  writeFileSync(`${torn}.lock`, ""); age(`${torn}.lock`, 10_000);
  for (const file of [dead, remote, torn]) {
    const ledger = createFileSpendLedger(file);
    assert.equal(await ledger.reserveAsync("s", 1n, "h", 5n, 60_000, Date.now()), true, file);
    assert.equal(await ledger.commitAsync("h", "tx"), true);
    assert.equal(existsSync(`${file}.lock`), false, "released after the write");
    assert.equal(ledger.spentMicro("s", 60_000, Date.now()), 1n);
  }
});

test("a reaper directory never blocks release, and the lock is not left behind", async () => {
  const file = tmpLedger("reaper-release");
  mkdirSync(`${file}.lock.reaper`);
  const ledger = createFileSpendLedger(file);
  assert.equal(await ledger.reserveAsync("s", 1n, "h", undefined, 60_000, Date.now()), true);
  assert.equal(await ledger.markSignedAsync("h"), true);
  assert.equal(await ledger.commitAsync("h", "tx"), true);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("the synchronous record waits for a live foreign lock, then throws; snapshot reads still answer", async () => {
  const file = tmpLedger("sync");
  const ledger = createFileSpendLedger(file);
  ledger.record("s", 4n, Date.now());
  // A live same-host owner: stale only once its pid is gone, however old.
  lockAt(file, { pid: process.ppid, hostname: await localIdentity(), acquiredAt: Date.now() - 120_000, token: "parent" });
  assert.equal(ledger.spentMicro("s", 60_000, Date.now()), 4n, "reads take no lock");
  assert.equal(ledger.firstSeen("s") !== undefined, true);
  assert.throws(() => ledger.record("s", 1n, Date.now()), /spend ledger lock timeout: .*held by pid \d+ since .*remove the lock/);
  assert.equal(ledger.spentMicro("s", 60_000, Date.now()), 4n, "the refused record wrote nothing");
});

test("an unterminated last line: skipped while a writer holds the lock, refused once none does", async () => {
  const file = tmpLedger("tail");
  const ledger = createFileSpendLedger(file);
  ledger.record("s", 3n, Date.now());
  appendFileSync(file, '{"v":2,"type":"ho');
  // A live writer holds the lock: the line is an append in progress.
  lockAt(file, { pid: process.ppid, hostname: await localIdentity(), acquiredAt: Date.now(), token: "appending" });
  const reread = createFileSpendLedger(file);
  assert.equal(reread.spentMicro("s", 60_000, Date.now()), 3n, "a row still being appended is not read");
  // No lock: a crashed append. Reads refuse rather than read less spent; writes refuse too.
  unlinkSync(`${file}.lock`);
  assert.throws(() => reread.spentMicro("s", 60_000, Date.now()), /unterminated last line/);
  await assert.rejects(() => reread.reserveAsync("s", 1n, "h", undefined, 60_000, Date.now()), /unterminated last line/);
  assert.throws(() => reread.record("s", 1n, Date.now()), /unterminated last line/);
  assert.equal(existsSync(`${file}.lock`), false, "a refused write releases the lock");
});

test("an orphaned session voucher counts only what it adds above the channel's committed high-water", async () => {
  const file = tmpLedger("orphan-channel");
  const ledger = createFileSpendLedger(file);
  assert.equal(await ledger.reserveChannelAsync("mpp", 150n, "b", undefined, 3_600_000, Date.now(), "chan", 150n), true);
  assert.equal(await ledger.markSignedAsync("b"), true);
  assert.equal(await ledger.commitAsync("b", undefined, undefined, "chan", 150n), true);
  // A signed hold for an older voucher (cumulative 100) whose process died after
  // the 150 voucher committed. Appended as its owner would have written it.
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const prev = createHash("sha256").update(lines[lines.length - 1]).digest("hex");
  const row = { v: 2, type: "hold", hold_id: "a", at: Date.now(), scope: "mpp", micro: "0", hold_micro: "100", prev,
    pid: await deadPid(), hostname: await localIdentity(), signed: true, channel_id: "chan", voucher_total_micro: "100" };
  appendFileSync(file, `${JSON.stringify(row)}\n`);
  const reread = createFileSpendLedger(file);
  assert.equal(reread.spentMicro("mpp", 3_600_000, Date.now()), 150n, "not 250: the older voucher adds nothing");
  assert.equal(await reread.reserveAsync("other", 1n, "x", undefined, 60_000, Date.now()), true, "a write settles the orphan durably");
  assert.equal(createFileSpendLedger(file).spentMicro("mpp", 3_600_000, Date.now()), 150n);
  assert.equal(createFileSpendLedger(file).highestSpentMicroByChannel("chan"), 150n);
});
