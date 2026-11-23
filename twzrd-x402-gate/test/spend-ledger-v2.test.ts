import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFileSpendLedger, tokenAmountToMicroUsdCeil } from "../src/spend-ledger-file.js";

const dir = mkdtempSync(join(tmpdir(), "spend-v2-"));
const file = join(dir, ".twzrd", "spend.jsonl");
const modulePath = resolve("src/spend-ledger-file.ts");
const spawnLedger = (script: string, args: string[] = []) => new Promise<string>((resolvePromise, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, modulePath, file, ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.setEncoding("utf8").on("data", x => out += x); child.stderr.setEncoding("utf8").on("data", x => err += x);
  child.on("error", reject); child.on("close", code => code === 0 ? resolvePromise(out.trim()) : reject(new Error(err)));
});

try {
  const ledger = createFileSpendLedger(file);
  assert.equal(ledger.reserve("buyer", 75n, "hold-live", 100n, 3_600_000, Date.now()), true);
  assert.equal(ledger.spentMicro("buyer", 3_600_000, Date.now()), 75n, "open holds count toward caps");
  assert.equal(ledger.markSigned("hold-live"), true);
  assert.equal(ledger.release("hold-live"), true);
  assert.equal(ledger.commit("hold-live", "tx-late"), false, "first resolution is final");
  assert.equal(ledger.spentMicro("buyer", 3_600_000, Date.now()), 0n, "released hold never commits late");

  const lockScript = `import {createFileSpendLedger} from ${JSON.stringify(modulePath)}; const l=createFileSpendLedger(process.argv[2]); const id='r'+process.pid; const ok=l.reserve('race',75n,id,100n,3600000,Date.now()); if(ok) l.markSigned(id); console.log(ok?'reserved':'refused');`;
  const contenders = await Promise.all([spawnLedger(lockScript), spawnLedger(lockScript)]);
  assert.equal(contenders.filter(x => x === "reserved").length, 1, "separate processes cannot race past a shared cap");
  assert.equal(createFileSpendLedger(file).spentMicro("race", 3_600_000, Date.now()), 75n);

  const deadSigned = `import {createFileSpendLedger} from ${JSON.stringify(modulePath)}; const l=createFileSpendLedger(process.argv[2]); l.reserve('crash',9n,'dead-signed',undefined,3600000,Date.now()); l.markSigned('dead-signed');`;
  await spawnLedger(deadSigned);
  const afterCrash = createFileSpendLedger(file);
  assert.equal(afterCrash.spentMicro("crash", 3_600_000, Date.now()), 9n, "dead signed hold is conservatively committed");
  assert.equal(afterCrash.commit("dead-signed", "late-tx"), false, "orphan resolution prevents late double count");

  const deadSession = `import {createFileSpendLedger} from ${JSON.stringify(modulePath)}; const l=createFileSpendLedger(process.argv[2]); l.reserveChannel('mpp',12n,'dead-channel',undefined,3600000,Date.now(),'channel-dead',12n); l.markSigned('dead-channel');`;
  await spawnLedger(deadSession);
  assert.equal(createFileSpendLedger(file).highestSpentMicroByChannel("channel-dead"), 12n, "orphan session commit restores channel high-water in the same read");

  const deadUnsigned = `import {createFileSpendLedger} from ${JSON.stringify(modulePath)}; const l=createFileSpendLedger(process.argv[2]); l.reserve('crash-u',11n,'dead-unsigned',undefined,3600000,Date.now());`;
  await spawnLedger(deadUnsigned);
  assert.equal(createFileSpendLedger(file).spentMicro("crash-u", 3_600_000, Date.now()), 0n, "dead unsigned hold is released");

  const live = createFileSpendLedger(file);
  assert.equal(live.reserve("stream", 13n, "long-stream", undefined, 60_000, Date.now() - 120_000), true);
  assert.equal(live.spentMicro("stream", 3_600_000, Date.now()), 13n, "a live owner is not expired by hold timeout");
  assert.equal(tokenAmountToMicroUsdCeil(1n, 7), 1n, "sub-micro token amount rounds up");
  assert.equal(tokenAmountToMicroUsdCeil(100_000_001n, 8), 1_000_001n);

  // Legacy 0.27.0 row replays as committed spend; its original JSON bytes stay the chain input.
  const legacy = join(dir, "legacy.jsonl");
  const { createHash } = await import("node:crypto");
  const raw = JSON.stringify({ at: 100, scope: "legacy", micro: "17", prev: "genesis" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(legacy, `${raw}\n`);
  assert.equal(createFileSpendLedger(legacy).spentMicro("legacy", 1000, 200), 17n);

  const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(rows.every(row => row.v === 2), "new event rows are versioned v2");
  assert.ok(rows.every((row, i) => i === 0 || row.prev === createHash("sha256").update(JSON.stringify(rows[i - 1])).digest("hex")));
} finally { rmSync(dir, { recursive: true, force: true }); }
