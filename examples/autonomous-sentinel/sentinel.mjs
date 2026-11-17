#!/usr/bin/env node
// twzrd-sentinel: an autonomous buyer under a signed spend mandate.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { VERSION, formatBreakerReport, startSidecar, verifyBreakers } from "@twzrd1111/mandate";
import { DEFAULT_LOOPBACK_PORT, openSentinel, recordSession, runLoop } from "./lib/sentinel.mjs";

const HELP = `twzrd-sentinel: an autonomous buyer that runs under a signed spend mandate (@twzrd1111/mandate ${VERSION})

  twzrd-sentinel --verify-breakers [--json]
      Prove on this machine that each of the six pre-sign layers refuses with 0 signatures.

  twzrd-sentinel run [flags]
      Loop: discover paid tasks, screen the seller, hold budget, pay once, verify the receipt
      and its log inclusion, reconcile the ledger, sign a heartbeat.

      Default is loopback: a seller, a trust service and a receipt log on 127.0.0.1, paid with a
      throwaway key. No wallet, no network, no money. With no mandate.json in --dir, the agent
      issues itself one.

    --dir <dir>              where mandate.json, agent.json and the state directory live (default .)
    --mandate <file>         a mandate to run under (default <dir>/mandate.json)
    --agent-key <file>       the agent's key file (default <dir>/agent.json)
    --trust-issuer <pubkey>  an operator key this agent accepts mandates from (repeatable)
    --cycles <n>             stop after n cycles (default: run until stopped)
    --interval <seconds>     pause between cycles (default 60)
    --control-port <port>    also serve /mandate/status, /mandate/kill, /mandate/resume on 127.0.0.1
    --loopback-port <port>   port of the loopback world (default ${DEFAULT_LOOPBACK_PORT})
    --record <file>          loopback only: run one scripted session and write it as
                             twzrd.mandate.session.v1 (--source-commit <sha>, default git HEAD)
    --json                   one JSON line per step and per heartbeat

    --live                   use the real catalog and trust service (https://intel.twzrd.xyz).
                             Needs --mandate. Without --pay-module it is a dry run: tasks are
                             discovered and screened, and every 402 is refused unpaid.
    --pay-module <file>      live only: a module exporting wrapPay(guardedFetch), the payer
    --intel-base <url>       live only: another trust service
    --tasks a,b              catalog offer ids to attempt (live default: twzrd_trust)
    --max-tasks <n>          most tasks per cycle (default 8)

  Exit codes: 0 stopped or cycles done; 1 the ledger or heartbeat did not verify, or a breaker
  failed; 2 usage, or a mandate the agent will not start under; 3 the mandate expired.
`;

function fail(message) {
  process.stderr.write(`twzrd-sentinel: ${message}\n`);
  process.exit(2);
}

function whole(name, value, min) {
  if (value === undefined) return undefined;
  if (!/^[0-9]{1,9}$/.test(value) || Number(value) < min) fail(`--${name} must be a whole number of at least ${min}`);
  return Number(value);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        "verify-breakers": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        dir: { type: "string" },
        mandate: { type: "string" },
        "agent-key": { type: "string" },
        "trust-issuer": { type: "string", multiple: true },
        cycles: { type: "string" },
        interval: { type: "string" },
        "control-port": { type: "string" },
        "loopback-port": { type: "string" },
        record: { type: "string" },
        "source-commit": { type: "string" },
        live: { type: "boolean" },
        "pay-module": { type: "string" },
        "intel-base": { type: "string" },
        tasks: { type: "string" },
        "max-tasks": { type: "string" },
      },
    });
  } catch (err) {
    fail(err.message);
  }
  const { values, positionals } = parsed;
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  if (values.help || (positionals.length === 0 && !values["verify-breakers"])) return void process.stdout.write(HELP);

  if (values["verify-breakers"]) {
    const report = await verifyBreakers();
    process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatBreakerReport(report));
    process.exit(report.ok ? 0 : 1);
  }
  if (positionals[0] !== "run" || positionals.length > 1) fail(`unknown command: ${positionals.join(" ")} (try --help)`);
  if (values.record !== undefined && values.live) fail("--record is loopback only");

  // Every flag is checked before anything is opened, so a usage error leaves nothing behind.
  const numbers = {
    loopbackPort: whole("loopback-port", values["loopback-port"], 0),
    maxTasks: whole("max-tasks", values["max-tasks"], 1),
    controlPort: whole("control-port", values["control-port"], 0),
    cycles: whole("cycles", values.cycles, 1),
    interval: whole("interval", values.interval, 0),
  };

  const say = (line) => process.stderr.write(`${line}\n`);
  const out = (doc) => process.stdout.write(`${JSON.stringify(doc)}\n`);
  let sentinel;
  try {
    sentinel = await openSentinel({
      dir: values.dir,
      mandate: values.mandate,
      agentKey: values["agent-key"],
      trustIssuers: values["trust-issuer"],
      live: values.live === true,
      payModule: values["pay-module"],
      intelBase: values["intel-base"],
      loopbackPort: numbers.loopbackPort,
      tasks: values.tasks !== undefined ? values.tasks.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      maxTasks: numbers.maxTasks,
      log: say,
    });
  } catch (err) {
    fail(err.message);
  }

  const m = sentinel.mandate;
  say(`twzrd-sentinel ${sentinel.mode}: mandate ${m.mandateId} (${m.issuerMode}), ${m.limits.maxPerCallUsd} USD a call, ${m.limits.dailyCeilingUsd} a day, expires ${m.expiresAt}`);
  if (sentinel.mode === "live-dry-run") say("dry run: no pay module, so every 402 is refused unpaid (no_payer_configured)");

  const onStep = (step) => {
    if (values.json) return out({ event: "step", ...step, receipt: { ...step.receipt, document: undefined } });
    const what = step.outcome === "refused" ? `REFUSED layer ${step.layer} ${step.code}` : step.outcome === "settled" ? `SETTLED ${step.settledUsd} USDC` : step.outcome.toUpperCase();
    say(`  ${String(step.n).padStart(2)}  ${what.padEnd(44)} sig ${step.signatures}  ${step.title}`);
  };

  let control = null;
  let exitCode = 0;
  try {
    if (values.record !== undefined) {
      const commit = values["source-commit"] ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const session = await recordSession(sentinel, { commit, onStep });
      const refusedSignatures = session.steps.filter((s) => s.outcome === "refused").reduce((sum, s) => sum + s.signatures, 0);
      if (refusedSignatures !== 0 || session.payerSignatures !== session.totals.signatures || session.sellerPayments !== session.totals.settled || session.strayRequests !== 0) {
        throw new Error("the recorded session does not add up: a refusal signed, a request left 127.0.0.1, or the payer and seller counts disagree with the ledger");
      }
      const { payerSignatures, sellerPayments, strayRequests, ...doc } = session;
      fs.writeFileSync(path.resolve(values.record), `${JSON.stringify(doc, null, 2)}\n`);
      say(`recorded ${doc.steps.length} steps: ${doc.totals.settled} settled (${doc.totals.settledUsd} USDC), ${doc.totals.refusals} refused, ${doc.totals.signatures} signatures; payer signed ${payerSignatures}, seller was paid ${sellerPayments} times`);
      say(`wrote ${path.resolve(values.record)}`);
    } else {
      if (numbers.controlPort !== undefined) {
        control = await startSidecar({ runtime: sentinel.runtime, version: VERSION, port: numbers.controlPort });
        say(`control API on ${control.url} (status, kill, resume)`);
      }
      let stopper = () => {};
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stopper());
      const result = await runLoop(sentinel, {
        cycles: numbers.cycles,
        intervalMs: (numbers.interval ?? 60) * 1000,
        onStopper: (halt) => (stopper = halt),
        onStep,
        onCycle: (cycle, n) => {
          const beat = cycle.heartbeat;
          if (values.json) return out({ event: "heartbeat", cycle: n, ok: cycle.ok, heartbeat: beat });
          const idle = cycle.stopped ? ` idle: ${cycle.stopped.code}` : "";
          say(`heartbeat ${beat.seq}: decisions ${beat.decisions}, refusals ${beat.refusals}, settled ${beat.settledUsd} USDC, left ${beat.remainingBudgetUsd.hour} this hour and ${beat.remainingBudgetUsd.day} today, ledger ${beat.ledgerHeadHash.slice(0, 16)} ${cycle.ok ? "verified" : "DID NOT VERIFY"}${idle}`);
        },
      });
      exitCode = result.exitCode;
      say(`stopped after ${result.cycles} cycle(s): ${result.reason}`);
    }
  } catch (err) {
    say(`twzrd-sentinel: ${err.message}`);
    exitCode = 1;
  } finally {
    if (control) await control.close();
    await sentinel.close();
  }
  process.exit(exitCode);
}

main();
