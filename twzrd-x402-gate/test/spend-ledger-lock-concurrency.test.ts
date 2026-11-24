import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const journals = (file: string) => readdirSync(dirname(file)).filter(name => name.includes(".pending."));
const chainRows = (file: string) => readFileSync(file, "utf8").trim().split("\n").length;
const tagOf = (identity: string) => createHash("sha256").update(identity).digest("hex").slice(0, 16);

test("the synchronous record never waits: under a live foreign lock it journals, every reader counts it, and it is merged once", async () => {
  const file = tmpLedger("sync");
  const ledger = createFileSpendLedger(file);
  ledger.record("s", 4n, Date.now());
  // A live same-host owner: stale only once its pid is gone, however old.
  lockAt(file, { pid: process.ppid, hostname: await localIdentity(), acquiredAt: Date.now() - 120_000, token: "parent" });
  assert.equal(ledger.spentMicro("s", 60_000, Date.now()), 4n, "reads take no lock");
  assert.equal(ledger.firstSeen("s") !== undefined, true);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  const started = Date.now();
  ledger.record("s", 1n, Date.now());
  const took = Date.now() - started;
  await new Promise(done => setTimeout(done, 30));
  clearInterval(timer);
  assert.ok(took < 200, `record returned without waiting for the lock (${took} ms)`);
  assert.ok(ticks >= 2, "the event loop kept running");
  assert.equal(journals(file).length, 1, "the row went to this writer's journal");
  assert.equal(chainRows(file), 1, "not in the chain while another process holds the lock");
  assert.equal(ledger.spentMicro("s", 60_000, Date.now()), 5n, "this process counts the journaled row");
  assert.equal(createFileSpendLedger(file).spentMicro("s", 60_000, Date.now()), 5n, "so does every other reader");
  assert.equal(await createFileSpendLedger(file).reserveAsync("s", 1n, "x", 5n, 60_000, Date.now()).catch(() => "timeout"), "timeout", "the lock is still held");
  unlinkSync(`${file}.lock`);
  assert.equal(await ledger.flushPending(), true);
  assert.equal(journals(file).length, 0, "journal folded and removed");
  assert.equal(chainRows(file), 2, "merged into the chain");
  assert.equal(createFileSpendLedger(file).spentMicro("s", 60_000, Date.now()), 5n, "counted once");
  assert.equal(await ledger.flushPending(), true, "nothing left to flush");
});

test("a dead writer's journal is counted at once and folded once by the next locked write; a live writer's is counted, not folded", async () => {
  const file = tmpLedger("dead-journal");
  const identity = await localIdentity();
  const dead = await deadPid();
  const deadJournal = `${file}.pending.${tagOf(identity)}.${dead}.0`;
  writeFileSync(deadJournal, JSON.stringify({ id: "legacy-dead-1", scope: "s", micro: "6", at: Date.now(), pid: dead, hostname: identity }) + "\n");
  // A live writer on this host (the parent process) with a row of its own.
  const liveJournal = `${file}.pending.${tagOf(identity)}.${process.ppid}.0`;
  writeFileSync(liveJournal, JSON.stringify({ id: "legacy-live-1", scope: "s", micro: "1", at: Date.now(), pid: process.ppid, hostname: identity }) + "\n");
  const ledger = createFileSpendLedger(file);
  assert.equal(ledger.spentMicro("s", 60_000, Date.now()), 7n, "both journals count before any merge");
  assert.equal(await ledger.reserveAsync("s", 1n, "h1", 8n, 60_000, Date.now()), true, "the cap sees journaled spend");
  assert.equal(await ledger.reserveAsync("s", 1n, "h2", 8n, 60_000, Date.now()), false, "and refuses past it");
  assert.equal(existsSync(deadJournal), false, "the dead writer's journal was folded and removed");
  assert.equal(existsSync(liveJournal), true, "a live writer's journal is left to its owner");
  const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as { hold_id: string; type: string; micro: string });
  assert.deepEqual(rows.filter(r => r.hold_id === "legacy-dead-1").map(r => [r.type, r.micro]), [["commit", "6"]], "folded exactly once");
  assert.equal(rows.some(r => r.hold_id === "legacy-live-1"), false);
  assert.equal(ledger.spentMicro("s", 60_000, Date.now()), 8n, "6 folded + 1 journaled + 1 held, each counted once");
  // A crash between the fold and the removal: the chain already holds the row, so it is skipped.
  writeFileSync(deadJournal, JSON.stringify({ id: "legacy-dead-1", scope: "s", micro: "6", at: Date.now(), pid: dead, hostname: identity }) + "\n");
  assert.equal(ledger.spentMicro("s", 60_000, Date.now()), 8n, "a re-found folded row is not counted twice");
  assert.equal(await ledger.releaseAsync("h1"), true);
  assert.equal(existsSync(deadJournal), false);
  assert.equal(ledger.spentMicro("s", 60_000, Date.now()), 7n);
});

function recordChild(file: string, source: string): Promise<void> {
  const body = `import { createFileSpendLedger } from ${JSON.stringify(new URL("../src/spend-ledger-file.ts", import.meta.url).href)};
    const ledger = createFileSpendLedger(${JSON.stringify(file)});
    ${source}`;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", body], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", fail);
    child.once("exit", code => code === 0 ? done() : fail(new Error(`child exited ${code}: ${stderr}`)));
  });
}

test("concurrent writer processes under a held lock: every row journaled, counted, then folded exactly once after they exit", async () => {
  const file = tmpLedger("multi-journal");
  lockAt(file, { pid: process.ppid, hostname: await localIdentity(), acquiredAt: Date.now(), token: "parent" });
  // Four processes record three rows each while the lock is held, then exit without waiting for a flush.
  await Promise.all(Array.from({ length: 4 }, () => recordChild(file, `for (let i = 0; i < 3; i++) ledger.record("s", 2n, Date.now());`)));
  assert.equal(journals(file).length, 4, "one journal per writer, left behind: the lock was held at exit");
  assert.equal(existsSync(file), false, "nothing reached the chain");
  assert.equal(createFileSpendLedger(file).spentMicro("s", 60_000, Date.now()), 24n, "a fresh reader counts every journaled row");
  unlinkSync(`${file}.lock`);
  const ledger = createFileSpendLedger(file);
  assert.equal(await ledger.reserveAsync("s", 2n, "h", 26n, 60_000, Date.now()), true, "the cap sees all 24");
  assert.equal(await ledger.reserveAsync("s", 1n, "h2", 26n, 60_000, Date.now()), false);
  assert.equal(journals(file).length, 0, "dead writers' journals folded and removed");
  const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as { type: string; hold_id: string });
  assert.equal(rows.filter(r => r.type === "commit").length, 12);
  assert.equal(new Set(rows.filter(r => r.type === "commit").map(r => r.hold_id)).size, 12, "each row folded once");
  assert.equal(createFileSpendLedger(file).spentMicro("s", 60_000, Date.now()), 26n);
});

test("a writer whose lock clears before it exits folds its own journal at exit, without a flush", async () => {
  const file = tmpLedger("exit-fold");
  const identity = await localIdentity();
  // The child records under a held lock (journal), clears the lock, then exits at once: only the exit fold can merge it.
  await recordChild(file, `
    const { writeFileSync, unlinkSync, readdirSync } = await import("node:fs");
    writeFileSync(${JSON.stringify(`${file}.lock`)}, JSON.stringify({ pid: ${process.pid}, hostname: ${JSON.stringify(identity)}, acquiredAt: Date.now(), token: "test" }));
    ledger.record("s", 3n, Date.now());
    if (!readdirSync(${JSON.stringify(dirname(file))}).some(n => n.includes(".pending."))) throw new Error("expected a journal");
    unlinkSync(${JSON.stringify(`${file}.lock`)});
    process.exit(0);`);
  assert.equal(journals(file).length, 0, "folded at exit");
  assert.equal(chainRows(file), 1);
  assert.equal(createFileSpendLedger(file).spentMicro("s", 60_000, Date.now()), 3n);
});

test("journal rows are idempotent by id across files, and a malformed complete row fails closed even from a live writer", async () => {
  const identity = await localIdentity();
  const row = (id: string, micro = "4") => JSON.stringify({ id, scope: "s", micro, at: Date.now(), pid: 1, hostname: identity }) + "\n";
  const file = tmpLedger("dup-journal");
  writeFileSync(`${file}.pending.${tagOf(identity)}.${await deadPid()}.0`, row("dup") + row("one"));
  writeFileSync(`${file}.pending.${tagOf(identity)}.${await deadPid()}.0`, row("dup"));
  assert.equal(createFileSpendLedger(file).spentMicro("s", 60_000, Date.now()), 8n, "the duplicate id counts once");
  await createFileSpendLedger(file).releaseAsync("nothing");
  assert.equal(journals(file).length, 0);
  const commits = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as { hold_id: string }).map(r => r.hold_id).sort();
  assert.deepEqual(commits, ["dup", "one"], "folded once each");
  const bad = tmpLedger("bad-live-journal");
  writeFileSync(`${bad}.pending.${tagOf(identity)}.${process.ppid}.0`, row("ok") + '{"id":"x","scope":"s","micro":"-1","at":1}\n');
  assert.throws(() => createFileSpendLedger(bad).spentMicro("s", 60_000, Date.now()), /corrupt|negative|amount/i);
  writeFileSync(`${bad}.pending.${tagOf(identity)}.${process.ppid}.0`, row("ok") + "not json\n");
  assert.throws(() => createFileSpendLedger(bad).spentMicro("s", 60_000, Date.now()), /pending journal corrupt row/);
});

test("a dead writer's journal with an unterminated last line is refused; a live writer's is an append in progress", async () => {
  const identity = await localIdentity();
  const row = (id: string) => JSON.stringify({ id, scope: "s", micro: "2", at: Date.now(), pid: 1, hostname: identity });
  const deadFile = tmpLedger("torn-dead-journal");
  writeFileSync(`${deadFile}.pending.${tagOf(identity)}.${await deadPid()}.0`, `${row("a")}\n${row("b").slice(0, 20)}`);
  assert.throws(() => createFileSpendLedger(deadFile).spentMicro("s", 60_000, Date.now()), /pending journal corrupt row \(unterminated last line\)/);
  const liveFile = tmpLedger("torn-live-journal");
  writeFileSync(`${liveFile}.pending.${tagOf(identity)}.${process.ppid}.0`, `${row("a")}\n${row("b").slice(0, 20)}`);
  assert.equal(createFileSpendLedger(liveFile).spentMicro("s", 60_000, Date.now()), 2n, "the complete row counts, the partial one is still being written");
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
