#!/usr/bin/env node
// x402 guard showcase: three acts on Base USDC and Solana USDC, on three seats
// (twzrd.safeFetch; createGuardedX402Fetch on an @x402/fetch client;
// createGuardedX402SolanaFetch on the stock x402-solana client, Solana only).
//
//   node showcase.mjs [--scenario allow|block|kill|all] [--json] [--interactive] [--data-dir <dir>]
//
// Prints each act as it finishes (or, with --json, one trace record per line),
// writes <data-dir>/showcase-transcript.json, and exits 0 when every check
// passes (or --interactive was stopped early with every check so far
// passing), 1 when one fails, 2 when it refused to start or a flag is wrong.
// The default data dir is ./data next to this file, whatever the working
// directory.
import { writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { ACTS, HALTED_CALLS_PER_RAIL, SEATS, ShowcaseRefusal, runShowcase } from "./lib/acts.mjs";
import { RAILS } from "./lib/rails.mjs";

const USAGE = "usage: node showcase.mjs [--scenario allow|block|kill|all] [--json] [--interactive] [--data-dir <dir>]";
const ACT_TITLE = { allow: "ALLOW", block: "BLOCK", kill: "KILL" };
const actNumber = (act) => ACTS.indexOf(act) + 1;

function shown(file) {
  const rel = relative(process.cwd(), file);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? file : `./${rel}`;
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => `  ${r.map((c, i) => String(c).padEnd(widths[i])).join("  ")}`.trimEnd()).join("\n");
}

const ms3 = (n) => `${n.toFixed(3)} ms`;
const short = (s) => `${s.slice(0, 6)}...${s.slice(-4)}`;
const title = (rail) => RAILS[rail].title;
const sellerSaw = (p) => (p.sellerPaid ? `402, then ${p.sellerPaid} paid request (${p.status})` : "402 only, 0 paid");
const receiptCell = (p) => (p.receiptVerified === null ? "-" : p.receiptVerified ? "verified" : "FAILED");
const checksLine = (checks) => `  checks ${checks.filter((c) => c.pass).length}/${checks.length}`;

function renderHeader(start) {
  const p = start.packages;
  const max = start.budget.maxSpendUsdc;
  return [
    `x402 guard showcase   twzrd-x402-gate ${p["twzrd-x402-gate"]}   twzrd-receipt-verifier ${p["twzrd-receipt-verifier"]}   @x402/fetch ${p["@x402/fetch"]}   x402-solana ${p["x402-solana"]}   node ${start.node}`,
    `seller  ${start.seller} (loopback, settles nothing)`,
    `rpc     ${start.rpc} (loopback Solana RPC stub for x402-solana: the mint, two token accounts, a blockhash)`,
    "seats   safe-fetch   twzrd.safeFetch with the recorded seller check",
    "        x402-fetch   createGuardedX402Fetch on an @x402/fetch client; TWZRD evaluator off (offline)",
    "        x402-solana  createGuardedX402SolanaFetch on the stock x402-solana client, Solana only; TWZRD evaluator off (offline)",
    "signer  demo signer (safe-fetch), demo exact scheme (x402-fetch), demo wallet (x402-solana): no key, nothing signed",
    `budget  ${max} USDC per call; safe-fetch ${max} in total, x402-fetch ${max} per hour per rail, x402-solana ${max} per hour`,
    `kill    ${shown(start.killFile)}`,
    `acts    ${start.acts.join(", ")}`,
  ].join("\n");
}

/** The x402-solana purchases in a list: the only ones with an RPC read count. */
const solanaOf = (purchases) => purchases.filter((p) => p.rpcCalls !== null);
const chainCell = (n) => (n === null ? "" : `chain reads ${n}`);

function renderAct(act, section, checks) {
  const out = [`ACT ${actNumber(act)}  ${ACT_TITLE[act]}${act === "kill" ? `  ${shown(section.killFile)}` : ""}`];
  if (act === "allow") {
    const r = section.receipt;
    out.push(
      table([
        ["seat", "rail", "shop", "decision", "signerInvocations", "receipt", "seller saw"],
        ...section.purchases.map((p) => [p.seat, title(p.rail), p.shop, p.decision, p.signerInvocations, receiptCell(p), sellerSaw(p)]),
      ]),
    );
    const sol = solanaOf(section.purchases);
    if (sol.length > 0) {
      const handed = sol.filter((p) => p.signedTransferMatchesOffer !== null);
      out.push(
        `  x402-solana read the chain after its hook approved: ${[...new Set(sol.map((p) => p.rpcCalls))].join("/")} RPC reads per payment`,
        `  transfers its wallet was handed that pay the approved offer: ${handed.filter((p) => p.signedTransferMatchesOffer).length}/${handed.length}`,
      );
    }
    out.push(
      `  V7 receipt (fixtures/intel-receipt-v7.json) checked offline: twzrd-receipt-verifier, key ${r.keyId} ${short(r.trustedPubkey)}`,
      table(
        r.cases.map((c) => [
          `  ${c.label}`,
          c.valid ? "VALID" : "INVALID",
          c.valid ? `subject ${short(r.subject)}  score ${r.score}  issued ${r.issuedAt.slice(0, 10)}` : (c.errors[0] ?? ""),
        ]),
      ),
      `    connections opened during the check: ${r.connectionsDuringCheck}`,
    );
  } else if (act === "block") {
    out.push(
      table([
        ["seat", "rail", "shop", "decision", "reason", "signerInvocations", "seller saw"],
        ...section.purchases.map((p) => [p.seat, title(p.rail), p.shop, p.decision, p.reason, p.signerInvocations, sellerSaw(p)]),
      ]),
    );
    const sol = solanaOf(section.purchases);
    if (sol.length > 0) out.push(`  x402-solana chain reads during its refusals: ${sol.reduce((n, p) => n + p.rpcCalls, 0)}`);
    out.push(`  safe-fetch budget spent by refusals: ${section.safeFetchBudgetSpentByRefusalsUsdc} USDC`);
  } else {
    out.push(
      "  in flight: one purchase per seat and rail, held when .kill was written",
      "  (safe-fetch on the seller check after its 402, x402-fetch on its 402,",
      "  x402-solana on its blockhash read, after its hook approved)",
      table(
        section.inFlight.map((p) => [
          p.seat,
          title(p.rail),
          p.decision,
          p.reason,
          p.stage,
          `signerInvocations ${p.signerInvocations}`,
          `seller paid ${p.sellerPaid}`,
          `refused ${ms3(p.killLatencyMs)} after .kill`,
          chainCell(p.rpcCalls),
        ]),
      ),
      `  halted: ${HALTED_CALLS_PER_RAIL} more purchases per seat and rail with .kill present`,
      table(
        section.halted.map((h) => [
          h.seat,
          title(h.rail),
          `${h.refusedOnEntry}/${h.attempts} refused on entry`,
          `signer calls ${h.demoSignerCalls}`,
          `seller requests ${h.sellerRequests}`,
          `p50 ${ms3(h.refusalMs.p50)}`,
          `max ${ms3(h.refusalMs.max)}`,
          chainCell(h.rpcCalls),
        ]),
      ),
      `  sub-millisecond halt: ${SEATS.map((s) => `${s} ${section.subMillisecond[s] ? "yes" : "no"}`).join(", ")} (a measurement, not a check;`,
      "  once released, the in-flight x402-solana purchase finishes a chain read and builds its transaction before its wallet refuses)",
      `  resumed: .kill ${section.killRemoved ? "removed (this run wrote it)" : "not removed"}`,
      table(
        section.resumed.map((p) => [
          p.seat,
          title(p.rail),
          p.shop,
          p.decision,
          `signerInvocations ${p.signerInvocations}`,
          `seller paid ${p.sellerPaid}`,
        ]),
      ),
    );
  }
  out.push(checksLine(checks), "");
  return out.join("\n");
}

function renderResult(t, file) {
  const passed = t.checks.filter((c) => c.pass).length;
  const ran = t.result === "stopped" ? ` (stopped; ran: ${t.actsRun.join(", ") || "none"})` : "";
  const out = [`RESULT  ${t.result.toUpperCase()}  ${passed}/${t.checks.length} checks${ran}`];
  for (const c of t.checks.filter((x) => !x.pass)) out.push(`  FAILED ${c.id}: ${c.observed}`);
  const byRail = (obj) =>
    Object.entries(obj)
      .map(([rail, n]) => `${title(rail)} ${n}`)
      .join(", ");
  const SIGNER = { "safe-fetch": "demo signer calls", "x402-fetch": "demo scheme calls", "x402-solana": "demo wallet calls" };
  const width = Math.max(...SEATS.map((seat) => seat.length));
  for (const seat of SEATS) {
    const s = t.totals.seats[seat];
    out.push(
      `  ${seat.padEnd(width)}  ${SIGNER[seat]} ${s.demoSignerCalls}, signerInvocations ${s.signerInvocations}, seller paid requests ${s.sellerPaid} (${byRail(s.sellerPaidByRail)})`,
      `  ${"".padEnd(width)}  events: onDecision ${s.events.onDecision}, onKill ${s.events.onKill}, onReceiptVerified ${s.events.onReceiptVerified}`,
    );
    if (s.signedTransfers) {
      const r = t.totals.solanaRpc;
      out.push(
        `  ${"".padEnd(width)}  transfers handed to the wallet ${s.signedTransfers.handed}, paying the approved offer ${s.signedTransfers.matchingOffer}`,
        `  ${"".padEnd(width)}  RPC reads: getAccountInfo ${r.getAccountInfo}, getLatestBlockhash ${r.getLatestBlockhash}, other ${r.other}`,
      );
    }
  }
  const sf = t.totals.seats["safe-fetch"];
  out.push(
    `  budget used: safe-fetch ${sf.ledgerBudgetUsedUsdc} of ${t.budget.maxSpendUsdc} USDC (one ledger, both rails); ` +
      `x402-fetch ${byRail(t.totals.seats["x402-fetch"].budgetUsedUsdc)}; x402-solana ${byRail(t.totals.seats["x402-solana"].budgetUsedUsdc)} USDC (demo; no USDC moved)`,
    `  TCP connections ${t.totals.tcpConnections}, all loopback; non-loopback refused ${t.totals.nonLoopbackConnectionsRefused}`,
    `  transcript ${shown(file)}`,
  );
  return out.join("\n");
}

/** Prompts on stderr before each act: Enter runs it, q or end of input stops. */
function interactivePrompter() {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  let closed = false;
  return {
    async beforeAct(act) {
      if (closed) return false;
      process.stderr.write(`next: ACT ${actNumber(act)} ${ACT_TITLE[act]}. Enter runs it, q stops: `);
      const line = await lines.next();
      // A terminal echoes the answer and its newline; piped input does not.
      if (line.done) process.stderr.write("(end of input)\n");
      else if (!process.stdin.isTTY) process.stderr.write(`${line.value}\n`);
      if (line.done || /^\s*q/i.test(line.value)) {
        closed = true;
        return false;
      }
      return true;
    },
    // Closing the reader releases stdin. Without it a terminal, or any stdin
    // left open, keeps the process alive after the last act.
    close() {
      reader.close();
    },
  };
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      scenario: { type: "string", default: "all" },
      json: { type: "boolean", default: false },
      interactive: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.scenario !== "all" && !ACTS.includes(values.scenario)) {
  console.error(`unknown scenario "${values.scenario}"\n${USAGE}`);
  process.exit(2);
}
const acts = values.scenario === "all" ? ACTS : [values.scenario];
const dataDir = values["data-dir"] ?? fileURLToPath(new URL("./data/", import.meta.url));
const transcriptFile = join(dataDir, "showcase-transcript.json");
const prompter = values.interactive ? interactivePrompter() : null;
const print = (text) => process.stdout.write(`${text}\n`);

let transcript;
try {
  transcript = await runShowcase({
    dataDir,
    acts,
    beforeAct: prompter?.beforeAct,
    onEvent: (record) => {
      if (values.json) print(JSON.stringify(record));
      else if (record.type === "start") print(`${renderHeader(record)}\n`);
    },
    afterAct: (act, section, checks) => {
      if (!values.json) print(renderAct(act, section, checks));
    },
  });
} catch (err) {
  if (err instanceof ShowcaseRefusal) {
    console.error(`refused to start: ${err.message}`);
    process.exit(2);
  }
  throw err;
} finally {
  prompter?.close();
}
writeFileSync(transcriptFile, `${JSON.stringify(transcript, null, 2)}\n`);
if (values.json) console.error(`transcript ${shown(transcriptFile)}`);
else print(renderResult(transcript, transcriptFile));
process.exitCode = transcript.result === "fail" ? 1 : 0;
