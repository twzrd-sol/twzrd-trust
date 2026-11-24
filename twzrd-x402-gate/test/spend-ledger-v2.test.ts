import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFileSpendLedger, tokenAmountToMicroUsdCeil } from "../src/spend-ledger-file.js";

const dir = mkdtempSync(join(tmpdir(), "spend-v2-"));
const file = join(dir, ".twzrd", "spend-v2.jsonl");
const modulePath = resolve("src/spend-ledger-file.ts");
const spawnLedger = (script: string, args: string[] = []) => new Promise<string>((resolvePromise, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, modulePath, file, ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.setEncoding("utf8").on("data", x => out += x); child.stderr.setEncoding("utf8").on("data", x => err += x);
  child.on("error", reject); child.on("close", code => code === 0 ? resolvePromise(out.trim()) : reject(new Error(err)));
});
const load = `import {createFileSpendLedger} from ${JSON.stringify(modulePath)}; const l=createFileSpendLedger(process.argv[2]);`;

try {
  const ledger = createFileSpendLedger(file);
  assert.equal(await ledger.reserveAsync("buyer", 75n, "hold-live", 100n, 3_600_000, Date.now()), true);
  assert.equal(ledger.spentMicro("buyer", 3_600_000, Date.now()), 75n, "open holds count toward caps");
  assert.equal(await ledger.reserveAsync("buyer", 30n, "hold-over", 100n, 3_600_000, Date.now()), false, "a hold past the cap is refused");
  assert.equal(await ledger.markSignedAsync("hold-live"), true);
  assert.equal(await ledger.releaseAsync("hold-live"), false, "a signed hold is never released: the payment can still settle");
  assert.equal(ledger.spentMicro("buyer", 3_600_000, Date.now()), 75n, "the signed hold stays counted");
  assert.equal(await ledger.commitAsync("hold-live", "tx-late"), true, "a late settlement commits it");
  assert.equal(await ledger.commitAsync("hold-live", "tx-later"), false, "first resolution is final");
  assert.equal(ledger.spentMicro("buyer", 3_600_000, Date.now()), 75n);
  assert.equal(await ledger.reserveAsync("buyer-u", 75n, "hold-unsigned", 100n, 3_600_000, Date.now()), true);
  assert.equal(await ledger.releaseAsync("hold-unsigned"), true, "an unsigned hold is released");
  assert.equal(await ledger.commitAsync("hold-unsigned", "tx-late-u"), false, "first resolution is final");
  assert.equal(ledger.spentMicro("buyer-u", 3_600_000, Date.now()), 0n, "released hold never commits late");

  const lockScript = `${load} const id='r'+process.pid; const ok=await l.reserveAsync('race',75n,id,100n,3600000,Date.now()); if(ok) await l.markSignedAsync(id); console.log(ok?'reserved':'refused');`;
  const contenders = await Promise.all([spawnLedger(lockScript), spawnLedger(lockScript)]);
  assert.equal(contenders.filter(x => x === "reserved").length, 1, "separate processes cannot race past a shared cap");
  assert.equal(createFileSpendLedger(file).spentMicro("race", 3_600_000, Date.now()), 75n);

  await spawnLedger(`${load} await l.reserveAsync('crash',9n,'dead-signed',undefined,3600000,Date.now()); await l.markSignedAsync('dead-signed');`);
  const afterCrash = createFileSpendLedger(file);
  assert.equal(afterCrash.spentMicro("crash", 3_600_000, Date.now()), 9n, "dead signed hold is conservatively committed");
  assert.equal(await afterCrash.commitAsync("dead-signed", "late-tx"), false, "orphan resolution prevents late double count");

  await spawnLedger(`${load} await l.reserveChannelAsync('mpp',12n,'dead-channel',undefined,3600000,Date.now(),'channel-dead',12n); await l.markSignedAsync('dead-channel');`);
  assert.equal(createFileSpendLedger(file).highestSpentMicroByChannel("channel-dead"), 12n, "orphan session commit restores channel high-water in the same read");

  await spawnLedger(`${load} await l.reserveAsync('crash-u',11n,'dead-unsigned',undefined,3600000,Date.now());`);
  assert.equal(createFileSpendLedger(file).spentMicro("crash-u", 3_600_000, Date.now()), 0n, "dead unsigned hold is released");

  const live = createFileSpendLedger(file);
  assert.equal(await live.reserveAsync("stream", 13n, "long-stream", undefined, 60_000, Date.now() - 120_000), true);
  assert.equal(live.spentMicro("stream", 3_600_000, Date.now()), 13n, "a live owner is not expired by hold timeout");
  assert.equal(tokenAmountToMicroUsdCeil(1n, 7), 1n, "sub-micro token amount rounds up");
  assert.equal(tokenAmountToMicroUsdCeil(100_000_001n, 8), 1_000_001n);

  // Settlement references count once, and the synchronous record shares the chain.
  assert.equal(await live.commitSettlementAsync("settle", 5n, "ref-1", Date.now()), true);
  assert.equal(await live.commitSettlementAsync("settle", 5n, "ref-1", Date.now()), false, "a reference already counted is not counted twice");
  assert.equal(live.settlementReferenceSeen("ref-1"), true);
  live.record("settle", 2n, Date.now());
  assert.equal(createFileSpendLedger(file).spentMicro("settle", 3_600_000, Date.now()), 7n);

  // Legacy 0.27.0 row replays as committed spend; its original JSON bytes stay the chain input.
  const legacy = join(dir, "legacy.jsonl");
  const raw = JSON.stringify({ at: 100, scope: "legacy", micro: "17", prev: "genesis" });
  writeFileSync(legacy, `${raw}\n`);
  assert.equal(createFileSpendLedger(legacy).spentMicro("legacy", 1000, 200), 17n);

  const lines = readFileSync(file, "utf8").trim().split("\n");
  const rows = lines.map(line => JSON.parse(line));
  assert.ok(rows.every(row => row.v === 2), "new event rows are versioned v2");
  assert.ok(rows.every((row, i) => i === 0 || row.prev === createHash("sha256").update(lines[i - 1]).digest("hex")), "every row chains from the bytes of the row before it");

  // A 0.27.0 reader sums `micro` over every row. Holds carry their amount in
  // hold_micro (micro "0"), so that sum is exactly the committed spend.
  assert.ok(rows.filter(row => row.type === "hold" || row.type === "hold_signed").every(row => row.micro === "0" && /^\d+$/.test(row.hold_micro)));
  assert.ok(rows.filter(row => row.type === "release").every(row => row.micro === "0"));
  const sum = (scope: string) => rows.filter(row => row.scope === scope).reduce((total, row) => total + BigInt(row.micro), 0n);
  const now = Date.now(), reread = createFileSpendLedger(file);
  for (const scope of ["buyer", "race", "crash", "crash-u", "settle"]) {
    assert.equal(sum(scope), reread.spentMicro(scope, 3_600_000, now), `0.27.0 reader sum matches committed spend for ${scope}`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
