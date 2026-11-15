#!/usr/bin/env node
// x402 guard showcase: three acts on Base USDC and Solana USDC.
//
//   node showcase.mjs [--data-dir <dir>]
//
// Prints the transcript, writes <data-dir>/showcase-transcript.json, and exits
// 0 when every check passes, 1 when one fails, 2 when it refused to start.
// The default data dir is ./data next to this file, whatever the working
// directory.
import { writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { HALTED_CALLS_PER_RAIL, ShowcaseRefusal, runShowcase } from "./lib/acts.mjs";
import { RAILS } from "./lib/rails.mjs";

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

function render(t, file) {
  const { allow, block, kill } = t.acts;
  const title = (rail) => RAILS[rail].title;
  const sellerSaw = (p) => (p.seller_paid ? `402, then ${p.seller_paid} paid request (${p.status})` : "402 only, 0 paid");
  const out = [];

  out.push(
    `x402 guard showcase   twzrd-x402-gate ${t.packages["twzrd-x402-gate"]}   twzrd-receipt-verifier ${t.packages["twzrd-receipt-verifier"]}   node ${t.node}`,
    `seller  ${t.seller.origin} (loopback, settles nothing)`,
    "signer  demo: holds no key, builds no transaction",
    `budget  ${t.budget.max_spend_usdc} USDC per call and in total, both rails`,
    `kill    ${shown(kill.kill_file)}`,
    "",
    "ACT 1  ALLOW",
    table([
      ["rail", "shop", "verdict", "signerInvocations", "seller saw"],
      ...allow.purchases.map((p) => [title(p.rail), p.path, p.verdict, p.signer_invocations, sellerSaw(p)]),
    ]),
    `  V7 receipt (fixtures/intel-receipt-v7.json) checked offline: twzrd-receipt-verifier, key ${allow.receipt.key_id} ${short(allow.receipt.trusted_pubkey)}`,
    table(
      allow.receipt.cases.map((c) => [
        `  ${c.label}`,
        c.valid ? "VALID" : "INVALID",
        c.valid
          ? `subject ${short(allow.receipt.subject)}  score ${allow.receipt.score}  issued ${allow.receipt.issued_at.slice(0, 10)}`
          : c.errors[0] ?? "",
      ]),
    ),
    `    connections opened during the check: ${allow.receipt.connections_during_check}`,
    "",
    "ACT 2  BLOCK",
    table([
      ["rail", "shop", "verdict", "reason", "signerInvocations", "seller check", "seller saw"],
      ...block.purchases.map((p) => [
        title(p.rail),
        p.path,
        p.verdict,
        p.reason,
        p.signer_invocations,
        p.seller_check_consulted ? "asked" : "not reached",
        sellerSaw(p),
      ]),
    ]),
    `  budget spent by refusals: ${block.budget_spent_by_refusals_usdc} USDC`,
    "",
    `ACT 3  KILL  ${shown(kill.kill_file)}`,
    "  in flight: one purchase per rail waiting on the seller check when .kill was written",
    table(
      kill.in_flight.map((e) => [
        title(e.rail),
        e.path,
        e.verdict,
        e.reason,
        `signerInvocations ${e.signer_invocations}`,
        `seller paid ${e.seller_paid}`,
        `refused ${ms3(e.kill_to_refusal_ms)} after .kill`,
      ]),
    ),
    `  halted: ${HALTED_CALLS_PER_RAIL} more purchases per rail with .kill present`,
    table(
      kill.halted.map((h) => [
        title(h.rail),
        `${h.refused_on_entry}/${h.attempts} refused on entry`,
        `signer calls ${h.demo_signer_calls}`,
        `seller requests ${h.seller_requests}`,
        `p50 ${ms3(h.refusal_ms.p50)}`,
        `max ${ms3(h.refusal_ms.max)}`,
      ]),
    ),
    `  sub-millisecond halt: ${kill.halt_sub_millisecond ? "yes" : "no (see the timings above)"}`,
    `  resumed: .kill ${kill.kill_removed ? "removed (this run wrote it)" : "not removed"}`,
    table(
      kill.resumed.map((p) => [
        title(p.rail),
        p.path,
        p.verdict,
        `signerInvocations ${p.signer_invocations}`,
        `seller paid ${p.seller_paid}`,
      ]),
    ),
    "",
  );

  const passed = t.checks.filter((c) => c.pass).length;
  out.push(`RESULT  ${t.result.toUpperCase()}  ${passed}/${t.checks.length} checks`);
  for (const c of t.checks.filter((x) => !x.pass)) out.push(`  FAILED ${c.id}: ${c.observed}`);
  const byRail = Object.entries(t.totals.seller_paid_by_rail)
    .map(([rail, n]) => `${title(rail)} ${n}`)
    .join(", ");
  out.push(
    `  demo signer calls ${t.totals.demo_signer_calls}, gate signerInvocations ${t.totals.gate_signer_invocations}, seller paid requests ${t.totals.seller_paid} (${byRail})`,
    `  budget used ${t.totals.budget_used_usdc} of ${t.budget.max_spend_usdc} USDC (demo ledger; no USDC moved)`,
    `  TCP connections ${t.totals.tcp_connections}, all loopback; non-loopback refused ${t.totals.non_loopback_connections_refused}`,
    `  transcript ${shown(file)}`,
  );
  return out.join("\n");
}

const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
const dataDir = values["data-dir"] ?? fileURLToPath(new URL("./data/", import.meta.url));

let transcript;
try {
  transcript = await runShowcase({ dataDir });
} catch (err) {
  if (err instanceof ShowcaseRefusal) {
    console.error(`refused to start: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
const transcriptFile = join(dataDir, "showcase-transcript.json");
writeFileSync(transcriptFile, `${JSON.stringify(transcript, null, 2)}\n`);
console.log(render(transcript, transcriptFile));
process.exitCode = transcript.result === "pass" ? 0 : 1;
