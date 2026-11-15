// The three acts, each on two seats per rail (lib/agent.mjs):
//   safe-fetch  twzrd.safeFetch
//   x402-fetch  the gate's createGuardedX402Fetch on an @x402/fetch client
// What each seat reports is checked against what its demo signer and the
// loopback seller saw. Every purchase is also one decision record in the
// trace (TRACE_SCHEMA), handed to onEvent as it happens.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMemorySpendLedger } from "twzrd-x402-gate";

import { AGENT_ID, MAX_SPEND, SEATS, createSafeFetchAgent, createX402Agent } from "./agent.mjs";
import { isHaltReason, roundMs, usdcFromBaseUnits } from "./guarded-fetch.mjs";
import { createKillSwitch, prepareDataDir } from "./kill-switch.mjs";
import { installNetGuard } from "./net-guard.mjs";
import { checkReceiptOffline } from "./receipt.mjs";
import { RAIL_IDS, RAILS } from "./rails.mjs";
import { createSellerCheck } from "./seller-check.mjs";
import { startSeller } from "./seller.mjs";

export { ShowcaseRefusal } from "./kill-switch.mjs";
export { SEATS } from "./agent.mjs";

export const SCHEMA = "twzrd.x402_guard_showcase.v2";
export const TRACE_SCHEMA = "twzrd.x402_guard_trace.v1";
export const ACTS = Object.freeze(["allow", "block", "kill"]);
/** Purchases per seat and rail attempted while .kill is present. */
export const HALTED_CALLS_PER_RAIL = 50;

const YEAR_MS = 365 * 24 * 3600 * 1000;
const toMs = (ns) => roundMs(Number(ns) / 1e6);
const usdc = (micro) => usdcFromBaseUnits(String(micro));

/** A dependency's version, read from its package.json (some packages do not export it). */
function versionOf(name) {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.name === name) return pkg.version;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// What each purchase must look like, per seat. "unpaid" is the 402 the seat
// reads before it decides; "paid" is a request carrying the demo signer's
// PAYMENT-SIGNATURE. The x402-fetch seat refuses the flagged seller with its
// recipient allowlist: its TWZRD evaluator, which would ask the live
// preflight, is off in this offline run.
const ALLOW = { decision: "allow", reason: null, stage: "pre_sign", signer: 1, paid: 1, unpaid: 1, status: 200, receipt: null };
const BLOCK = { decision: "block", stage: "pre_sign", signer: 0, paid: 0, unpaid: 1, status: null, receipt: null };
const EXPECT = {
  "safe-fetch": {
    "/good": ALLOW,
    "/receipt": { ...ALLOW, receipt: true },
    "/flagged": { ...BLOCK, reason: "intel_block", consulted: true },
    "/pricey": { ...BLOCK, reason: "over_max_spend", consulted: false },
    "/wrong-asset": { ...BLOCK, reason: "non_usdc_asset", consulted: false },
  },
  "x402-fetch": {
    "/good": ALLOW,
    "/receipt": { ...ALLOW, receipt: true },
    "/flagged": { ...BLOCK, reason: "unauthorized_recipient" },
    "/pricey": { ...BLOCK, reason: "price_cap_exceeded" },
    "/wrong-asset": { ...BLOCK, reason: "unsupported_or_non_usdc_asset" },
  },
};

const meets = (p, e) =>
  p.decision === e.decision &&
  p.reason === e.reason &&
  p.stage === e.stage &&
  p.signerInvocations === e.signer &&
  p.demoSignerCalls === e.signer &&
  p.sellerPaid === e.paid &&
  p.sellerUnpaid === e.unpaid &&
  p.status === e.status &&
  p.receiptVerified === e.receipt &&
  p.decisionsEmitted === 1 &&
  (e.consulted === undefined || p.sellerCheckConsulted === e.consulted);

const describe = (p) =>
  `${p.decision} ${p.reason ?? "-"} stage=${p.stage ?? "-"} signerInvocations=${p.signerInvocations} ` +
  `demo_signer=${p.demoSignerCalls} seller_402=${p.sellerUnpaid} seller_paid=${p.sellerPaid}` +
  (p.receiptVerified === null ? "" : ` receiptVerified=${p.receiptVerified}`);

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run the acts against a fresh loopback seller. `dataDir` holds the .kill
 * sentinel; it must not already hold a .kill or a .pause.
 *
 * acts       which acts to run, in the order of ACTS (default: all three)
 * beforeAct  async (act) => boolean; false stops the run before that act
 * afterAct   (act, section, checks) => void, once an act is done
 * onEvent    (record) => void, for each trace record as it happens
 */
export async function runShowcase({ dataDir, acts = ACTS, beforeAct, afterAct, onEvent } = {}) {
  const selected = ACTS.filter((act) => acts.includes(act));
  if (selected.length === 0 || acts.some((act) => !ACTS.includes(act))) {
    throw new TypeError(`acts must name one or more of: ${ACTS.join(", ")}`);
  }
  prepareDataDir(dataDir);
  const guard = installNetGuard();
  const killSwitch = createKillSwitch(dataDir);
  let seller;
  try {
    seller = await startSeller();
    return await play({ dataDir, selected, guard, killSwitch, seller, beforeAct, afterAct, onEvent });
  } finally {
    killSwitch.disengageIfOurs();
    await seller?.close();
    guard.uninstall();
  }
}

async function play({ dataDir, selected, guard, killSwitch, seller, beforeAct, afterAct, onEvent }) {
  const ledger = createMemorySpendLedger();
  const sellerCheck = createSellerCheck();
  const agents = { "safe-fetch": {}, "x402-fetch": {} };
  for (const id of RAIL_IDS) {
    const rail = RAILS[id];
    agents["safe-fetch"][id] = createSafeFetchAgent({ rail, dataDir, sellerOrigin: seller.origin, sellerCheck, ledger });
    agents["x402-fetch"][id] = createX402Agent({ rail, dataDir, sellerOrigin: seller.origin });
  }
  const eachAgent = (fn) => SEATS.flatMap((seat) => RAIL_IDS.map((id) => fn(seat, id, agents[seat][id])));

  const trace = [];
  const emit = (record) => {
    trace.push(record);
    onEvent?.(record);
  };
  const checks = [];
  const check = (id, pass, observed) => checks.push({ id, pass: Boolean(pass), observed });
  const made = new Map(eachAgent((seat, id, agent) => [agent.tag, []]));
  const budgetUsed = () => ledger.spentMicro(`agent:${AGENT_ID}`, YEAR_MS, Date.now());
  const url = (path) => `${seller.origin}${path}`;

  // One purchase, with what the demo signer and the seller saw during it. Each
  // agent has at most one purchase in flight, so the per-agent counts are its own.
  async function attempt(seat, id, path, act, step) {
    const agent = agents[seat][id];
    const before = {
      seller: seller.countsFor(agent.tag),
      signer: agent.signer.calls,
      consulted: sellerCheck.calls.length,
      receipts: agent.events.receipts.length,
    };
    const { record, body, emitted } = await agent.buy(url(path));
    const settledAt = process.hrtime.bigint();
    const after = seller.countsFor(agent.tag);
    const p = {
      type: "decision",
      act,
      step,
      seat,
      rail: id,
      shop: path,
      ...record,
      demoSignerCalls: agent.signer.calls - before.signer,
      sellerUnpaid: after.unpaid - before.seller.unpaid,
      sellerPaid: after.paid - before.seller.paid,
      sellerCheckConsulted: seat === "safe-fetch" ? sellerCheck.calls.length > before.consulted : null,
      decisionsEmitted: emitted ?? 1,
      killLatencyMs: null,
    };
    made.get(agent.tag).push(p);
    const receipts = agent.events.receipts.slice(before.receipts);
    return { p, body, settledAt, receipts };
  }
  const emitPurchase = ({ p, receipts }) => {
    emit(p);
    for (const r of receipts) {
      emit({ type: "receipt", act: p.act, step: p.step, seat: p.seat, chain: p.chain, source: "paid_response", ...r });
    }
    return p;
  };
  const purchase = async (...args) => emitPurchase(await attempt(...args));

  const sections = {};
  const run = {
    // ACT 1: ALLOW. A clean seller is paid on both rails by both seats, once
    // for plain content and once for a body that carries the V7 receipt; then
    // the receipt is checked offline, as issued and with one field changed.
    async allow() {
      const section = { purchases: [] };
      for (const seat of SEATS) {
        for (const id of RAIL_IDS) {
          for (const path of ["/good", "/receipt"]) {
            const p = await purchase(seat, id, path, "allow", path.slice(1));
            section.purchases.push(p);
            check(`allow.${seat}.${id}.${path.slice(1)}`, meets(p, EXPECT[seat][path]), describe(p));
          }
        }
      }
      const opened = () => guard.stats.connections + guard.stats.refused;
      const openedBefore = opened();
      const offline = [];
      section.receipt = checkReceiptOffline({ onReceiptVerified: (event) => offline.push(event) });
      section.receipt.connectionsDuringCheck = opened() - openedBefore;
      section.receipt.cases.forEach((c, i) => {
        emit({ type: "receipt", act: "allow", step: `offline.${c.name}`, seat: null, chain: null, source: "offline", ...offline[i] });
        check(`allow.receipt.${c.name}`, c.valid === c.expectValid, `valid=${c.valid} ${c.errors.join("; ")}`.trim());
      });
      check(
        "allow.receipt.offline",
        section.receipt.connectionsDuringCheck === 0,
        `connections=${section.receipt.connectionsDuringCheck}`,
      );
      return section;
    },

    // ACT 2: BLOCK. A flagged seller, a price over the cap and a token that is
    // not USDC, on both rails and both seats. Each is refused before the signer.
    async block() {
      const section = { purchases: [] };
      const budgetBefore = budgetUsed();
      for (const seat of SEATS) {
        for (const id of RAIL_IDS) {
          for (const path of ["/flagged", "/pricey", "/wrong-asset"]) {
            const p = await purchase(seat, id, path, "block", path.slice(1));
            section.purchases.push(p);
            check(`block.${seat}.${id}.${path.slice(1)}`, meets(p, EXPECT[seat][path]), describe(p));
          }
        }
      }
      section.safeFetchBudgetSpentByRefusalsUsdc = usdc(budgetUsed() - budgetBefore);
      check(
        "block.safe-fetch.budget_untouched",
        budgetUsed() === budgetBefore,
        `spent=${section.safeFetchBudgetSpentByRefusalsUsdc}`,
      );
      return section;
    },

    // ACT 3: KILL.
    async kill() {
      const section = { killFile: killSwitch.file, inFlight: [], halted: [], resumed: [] };

      // 3a. One purchase per seat and rail is in flight when .kill is written:
      // safe-fetch purchases wait on the seller check, after their 402;
      // x402-fetch purchases wait on their 402. Once released, each meets the
      // gate's look right before the signer, which finds .kill.
      const heldChecks = sellerCheck.hold(RAIL_IDS.length);
      const held402s = seller.hold402(RAIL_IDS.map((id) => agents["x402-fetch"][id].tag));
      const inFlight = eachAgent((seat, id) => attempt(seat, id, "/good", "kill", "in_flight"));
      await withTimeout(Promise.all([heldChecks.reached, held402s.reached]), 5000, "every purchase reaching its hold");
      killSwitch.engage();
      const killedAt = process.hrtime.bigint();
      heldChecks.release();
      held402s.release();
      emit({ type: "kill_switch", act: "kill", action: "engaged", file: killSwitch.file });
      for (const result of await Promise.all(inFlight)) {
        const p = emitPurchase({ ...result, p: Object.assign(result.p, { killLatencyMs: toMs(result.settledAt - killedAt) }) });
        section.inFlight.push(p);
        check(
          `kill.in_flight.${p.seat}.${p.rail}`,
          p.decision === "block" &&
            p.reason === "twzrd_kill_switch" &&
            p.stage === "pre_sign" &&
            p.signerInvocations === 0 &&
            p.demoSignerCalls === 0 &&
            p.sellerPaid === 0 &&
            p.decisionsEmitted === 1,
          describe(p),
        );
      }
      for (const seat of SEATS) {
        const answered = section.inFlight.filter((p) => p.seat === seat).reduce((n, p) => n + p.sellerUnpaid, 0);
        check(
          `kill.in_flight.${seat}.were_in_flight`,
          answered === RAIL_IDS.length,
          `seller answered ${answered} 402s to ${seat} purchases in flight`,
        );
      }

      // 3b. With .kill present, every purchase is refused on entry: no request
      // reaches the seller and the signer is never called.
      for (const seat of SEATS) {
        for (const id of RAIL_IDS) {
          const agent = agents[seat][id];
          const before = { seller: seller.countsFor(agent.tag), signer: agent.signer.calls };
          const times = [];
          let refused = 0;
          for (let i = 0; i < HALTED_CALLS_PER_RAIL; i += 1) {
            const p = await purchase(seat, id, "/good", "kill", "halted");
            times.push(p.elapsedMs);
            if (p.decision === "block" && p.reason === "twzrd_kill_switch" && p.stage === "entry" && p.signerInvocations === 0) {
              refused += 1;
            }
          }
          const after = seller.countsFor(agent.tag);
          times.sort((a, b) => a - b);
          const entry = {
            seat,
            rail: id,
            attempts: HALTED_CALLS_PER_RAIL,
            refusedOnEntry: refused,
            demoSignerCalls: agent.signer.calls - before.signer,
            sellerRequests: after.requests - before.seller.requests,
            refusalMs: { p50: times[Math.floor(times.length / 2)], max: times.at(-1) },
          };
          section.halted.push(entry);
          check(
            `kill.halted.${seat}.${id}`,
            refused === HALTED_CALLS_PER_RAIL && entry.demoSignerCalls === 0 && entry.sellerRequests === 0,
            `refused ${refused}/${HALTED_CALLS_PER_RAIL} demo_signer=${entry.demoSignerCalls} seller_requests=${entry.sellerRequests}`,
          );
        }
      }
      section.subMillisecond = Object.fromEntries(
        SEATS.map((seat) => [
          seat,
          section.inFlight.filter((p) => p.seat === seat).every((p) => p.killLatencyMs < 1) &&
            section.halted.filter((h) => h.seat === seat).every((h) => h.refusalMs.p50 < 1),
        ]),
      );

      // 3c. Remove the .kill this run wrote; payments resume on both rails and seats.
      section.killRemoved = killSwitch.disengage();
      emit({ type: "kill_switch", act: "kill", action: "removed", file: killSwitch.file });
      check("kill.removed_own_file", section.killRemoved, `removed=${section.killRemoved}`);
      for (const seat of SEATS) {
        for (const id of RAIL_IDS) {
          const p = await purchase(seat, id, "/good", "kill", "resumed");
          section.resumed.push(p);
          check(`kill.resumed.${seat}.${id}`, meets(p, EXPECT[seat]["/good"]), describe(p));
        }
      }
      return section;
    },
  };

  emit({
    type: "start",
    schema: TRACE_SCHEMA,
    transcriptSchema: SCHEMA,
    node: process.version,
    packages: {
      "twzrd-x402-gate": versionOf("twzrd-x402-gate"),
      "twzrd-receipt-verifier": versionOf("twzrd-receipt-verifier"),
      "@x402/core": versionOf("@x402/core"),
      "@x402/fetch": versionOf("@x402/fetch"),
    },
    seller: seller.origin,
    seats: [...SEATS],
    rails: RAIL_IDS.map((id) => ({ chain: id, network: RAILS[id].network, usdc: RAILS[id].usdc })),
    acts: [...selected],
    budget: { maxSpendUsdc: MAX_SPEND, agentId: AGENT_ID },
    killFile: killSwitch.file,
  });
  const start = trace[0];

  let stopped = false;
  for (const act of selected) {
    if (beforeAct && !(await beforeAct(act))) {
      stopped = true;
      break;
    }
    emit({ type: "act", act, phase: "start" });
    const checksBefore = checks.length;
    sections[act] = await run[act]();
    const mine = checks.slice(checksBefore);
    emit({ type: "act", act, phase: "end", passed: mine.filter((c) => c.pass).length, total: mine.length });
    afterAct?.(act, sections[act], mine);
  }

  // Each seat: the demo signer, the seat's own signerInvocations and the
  // seller's paid count agree, and the typed events match the purchases.
  const totals = { seats: {} };
  for (const seat of SEATS) {
    const mine = RAIL_IDS.map((id) => ({ id, agent: agents[seat][id], list: made.get(agents[seat][id].tag) }));
    const counts = mine.map(({ agent }) => seller.countsFor(agent.tag));
    const all = mine.flatMap((m) => m.list);
    const paidByRail = Object.fromEntries(mine.map(({ id }, i) => [id, counts[i].paid]));
    const t = {
      purchases: all.length,
      signerInvocations: all.reduce((n, p) => n + p.signerInvocations, 0),
      demoSignerCalls: mine.reduce((n, m) => n + m.agent.signer.calls, 0),
      sellerPaid: counts.reduce((n, c) => n + c.paid, 0),
      sellerPaidByRail: paidByRail,
      sellerRejectedPayments: counts.reduce((n, c) => n + c.rejected, 0),
      budgetUsedUsdc: Object.fromEntries(
        mine.map(({ id, list }) => [
          id,
          usdc(list.filter((p) => p.signerInvocations > 0).reduce((n, p) => n + BigInt(p.amount ?? 0), 0n)),
        ]),
      ),
      events: {
        onDecision: mine.reduce((n, m) => n + m.agent.events.decisions.length, 0),
        onKill: mine.reduce((n, m) => n + m.agent.events.kills.length, 0),
        onReceiptVerified: mine.reduce((n, m) => n + m.agent.events.receipts.length, 0),
      },
    };
    if (seat === "safe-fetch") t.ledgerBudgetUsedUsdc = usdc(budgetUsed());
    totals.seats[seat] = t;
    check(
      `totals.${seat}.signer_matches`,
      t.demoSignerCalls === t.signerInvocations && t.sellerPaid === t.demoSignerCalls && t.sellerRejectedPayments === 0,
      `demo_signer=${t.demoSignerCalls} signerInvocations=${t.signerInvocations} seller_paid=${t.sellerPaid} rejected=${t.sellerRejectedPayments}`,
    );
    const halts = all.filter((p) => p.decision === "block" && isHaltReason(p.reason)).length;
    const receipts = all.filter((p) => p.receiptVerified !== null).length;
    check(
      `events.${seat}`,
      t.events.onDecision === all.length && t.events.onKill === halts && t.events.onReceiptVerified === receipts,
      `onDecision ${t.events.onDecision}/${all.length} onKill ${t.events.onKill}/${halts} onReceiptVerified ${t.events.onReceiptVerified}/${receipts}`,
    );
  }
  totals.tcpConnections = guard.stats.connections;
  totals.nonLoopbackConnectionsRefused = guard.stats.refused;
  totals.nonLoopbackTargets = guard.stats.refused_targets;
  check("totals.loopback_only", guard.stats.refused === 0, `non_loopback_refused=${guard.stats.refused}`);

  const failed = checks.filter((c) => !c.pass);
  const result = failed.length > 0 ? "fail" : stopped ? "stopped" : "pass";
  emit({
    type: "result",
    result,
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map((c) => c.id),
    actsRun: Object.keys(sections),
  });

  return {
    schema: SCHEMA,
    traceSchema: TRACE_SCHEMA,
    generatedAt: new Date().toISOString(),
    node: start.node,
    packages: start.packages,
    seller: { origin: seller.origin },
    seats: [...SEATS],
    budget: start.budget,
    killFile: killSwitch.file,
    actsSelected: [...selected],
    actsRun: Object.keys(sections),
    acts: sections,
    totals,
    checks,
    trace,
    result,
  };
}
