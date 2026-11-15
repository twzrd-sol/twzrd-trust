// The three acts. Every purchase goes through the published twzrd.safeFetch;
// what the gate returns is checked against what the demo signer and the
// loopback seller saw.
import { createRequire } from "node:module";

import { createMemorySpendLedger } from "twzrd-x402-gate";

import { AGENT_ID, MAX_SPEND, createAgent } from "./agent.mjs";
import { createKillSwitch, prepareDataDir } from "./kill-switch.mjs";
import { installNetGuard } from "./net-guard.mjs";
import { checkReceiptOffline } from "./receipt.mjs";
import { RAIL_IDS, RAILS } from "./rails.mjs";
import { createSellerCheck } from "./seller-check.mjs";
import { startSeller } from "./seller.mjs";

export { ShowcaseRefusal } from "./kill-switch.mjs";

export const SCHEMA = "twzrd.x402_guard_showcase.v1";
/** Purchases per rail attempted while .kill is present. */
export const HALTED_CALLS_PER_RAIL = 50;

const require = createRequire(import.meta.url);
const versionOf = (name) => require(`${name}/package.json`).version;

const YEAR_MS = 365 * 24 * 3600 * 1000;
const usdc = (micro) => (Number(micro) / 1e6).toFixed(2);
const toMs = (ns) => Number(ns) / 1e6;

// What each purchase must look like. "unpaid" is the 402 the gate reads before
// it decides; "paid" is a request carrying the demo signer's PAYMENT-SIGNATURE.
const EXPECT = {
  allow: { verdict: "allow", reason: null, signer: 1, paid: 1, unpaid: 1, consulted: true, status: 200 },
  "/flagged": { verdict: "block", reason: "intel_block", signer: 0, paid: 0, unpaid: 1, consulted: true, status: null },
  "/pricey": { verdict: "block", reason: "over_max_spend", signer: 0, paid: 0, unpaid: 1, consulted: false, status: null },
  "/wrong-asset": { verdict: "block", reason: "non_usdc_asset", signer: 0, paid: 0, unpaid: 1, consulted: false, status: null },
};

const meets = (p, e) =>
  p.verdict === e.verdict &&
  p.reason === e.reason &&
  p.signer_invocations === e.signer &&
  p.demo_signer_calls === e.signer &&
  p.seller_paid === e.paid &&
  p.seller_unpaid === e.unpaid &&
  p.seller_check_consulted === e.consulted &&
  p.status === e.status;

const describe = (p) =>
  `${p.verdict} ${p.reason ?? "-"} signerInvocations=${p.signer_invocations} demo_signer=${p.demo_signer_calls}` +
  (p.seller_unpaid !== undefined ? ` seller_402=${p.seller_unpaid}` : "") +
  ` seller_paid=${p.seller_paid}`;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run the three acts against a fresh loopback seller. `dataDir` holds the
 * .kill sentinel; it must not already hold a .kill or a .pause.
 */
export async function runShowcase({ dataDir }) {
  prepareDataDir(dataDir);
  const guard = installNetGuard();
  const killSwitch = createKillSwitch(dataDir);
  let seller;
  try {
    seller = await startSeller();
    return await play({ dataDir, guard, killSwitch, seller });
  } finally {
    killSwitch.disengageIfOurs();
    await seller?.close();
    guard.uninstall();
  }
}

async function play({ dataDir, guard, killSwitch, seller }) {
  const ledger = createMemorySpendLedger();
  const sellerCheck = createSellerCheck();
  const agents = Object.fromEntries(
    RAIL_IDS.map((id) => [
      id,
      createAgent({ rail: RAILS[id], dataDir, sellerOrigin: seller.origin, sellerCheck, ledger }),
    ]),
  );
  const budgetUsed = () => ledger.spentMicro(`agent:${AGENT_ID}`, YEAR_MS, Date.now());
  const checks = [];
  const check = (id, pass, observed) => checks.push({ id, pass: Boolean(pass), observed });
  let gateSignerInvocations = 0;
  const url = (path) => `${seller.origin}${path}`;

  // One purchase, with what the demo signer and the seller saw during it.
  async function purchase(railId, path) {
    const agent = agents[railId];
    const before = { seller: seller.snapshot(), signer: agent.signer.calls, consulted: sellerCheck.calls.length };
    const started = process.hrtime.bigint();
    const result = await agent.buy(url(path));
    const elapsed = process.hrtime.bigint() - started;
    const after = seller.snapshot();
    gateSignerInvocations += result.signerInvocations;
    const body =
      result.verdict !== "block" && result.response ? await result.response.json().catch(() => null) : null;
    return {
      rail: railId,
      path,
      verdict: result.verdict,
      reason: result.reason ?? null,
      signer_invocations: result.signerInvocations,
      demo_signer_calls: agent.signer.calls - before.signer,
      seller_unpaid: after.unpaid - before.seller.unpaid,
      seller_paid: after.paid - before.seller.paid,
      seller_check_consulted: sellerCheck.calls.length > before.consulted,
      status: result.response?.status ?? null,
      body,
      ms: toMs(elapsed),
    };
  }

  // ACT 1: ALLOW. A clean seller is paid on both rails; then a signed V7
  // receipt is checked offline, as issued and with one field changed.
  const allow = { purchases: [] };
  for (const id of RAIL_IDS) {
    const p = await purchase(id, "/good");
    allow.purchases.push(p);
    check(`allow.${id}.good`, meets(p, EXPECT.allow), describe(p));
  }
  const opened = () => guard.stats.connections + guard.stats.refused;
  const openedBeforeReceipt = opened();
  allow.receipt = checkReceiptOffline();
  allow.receipt.connections_during_check = opened() - openedBeforeReceipt;
  for (const c of allow.receipt.cases) {
    check(`allow.receipt.${c.name}`, c.valid === c.expect_valid, `valid=${c.valid} ${c.errors.join("; ")}`.trim());
  }
  check(
    "allow.receipt.offline",
    allow.receipt.connections_during_check === 0,
    `connections=${allow.receipt.connections_during_check}`,
  );
  allow.budget_used_usdc = usdc(budgetUsed());

  // ACT 2: BLOCK. A flagged seller, a price over the cap and a token that is
  // not USDC, on both rails. Each is refused before the signer.
  const block = { purchases: [] };
  const budgetBeforeBlocks = budgetUsed();
  for (const id of RAIL_IDS) {
    for (const path of ["/flagged", "/pricey", "/wrong-asset"]) {
      const p = await purchase(id, path);
      block.purchases.push(p);
      check(`block.${id}.${path.slice(1)}`, meets(p, EXPECT[path]), describe(p));
    }
  }
  block.budget_spent_by_refusals_usdc = usdc(budgetUsed() - budgetBeforeBlocks);
  check("block.budget_untouched", budgetUsed() === budgetBeforeBlocks, `spent=${block.budget_spent_by_refusals_usdc}`);

  // ACT 3: KILL.
  const kill = { kill_file: killSwitch.file, in_flight: [], halted: [], resumed: [] };

  // 3a. One purchase per rail is past the entry check and waiting on the
  // seller check when .kill is written. The check then answers allow; the
  // gate's last look before the signer finds .kill and refuses.
  const hold = sellerCheck.hold(RAIL_IDS.length);
  const before3a = {
    seller: seller.snapshot(),
    signer: Object.fromEntries(RAIL_IDS.map((id) => [id, agents[id].signer.calls])),
  };
  const settledAt = {};
  const inFlight = RAIL_IDS.map((id) =>
    agents[id].buy(url("/good")).then((result) => {
      settledAt[id] = process.hrtime.bigint();
      return result;
    }),
  );
  await withTimeout(hold.reached, 5000, "both purchases reaching the seller check");
  killSwitch.engage();
  const killedAt = process.hrtime.bigint();
  hold.release();
  const results3a = await Promise.all(inFlight);
  const after3a = seller.snapshot();
  RAIL_IDS.forEach((id, i) => {
    const r = results3a[i];
    gateSignerInvocations += r.signerInvocations;
    const entry = {
      rail: id,
      path: "/good",
      verdict: r.verdict,
      reason: r.reason ?? null,
      signer_invocations: r.signerInvocations,
      demo_signer_calls: agents[id].signer.calls - before3a.signer[id],
      seller_paid: after3a.paidByRail[id] - before3a.seller.paidByRail[id],
      kill_to_refusal_ms: toMs(settledAt[id] - killedAt),
    };
    kill.in_flight.push(entry);
    check(
      `kill.in_flight.${id}`,
      entry.verdict === "block" &&
        entry.reason === "twzrd_kill_switch" &&
        entry.signer_invocations === 0 &&
        entry.demo_signer_calls === 0 &&
        entry.seller_paid === 0,
      describe(entry),
    );
  });
  kill.in_flight_seller_402s = after3a.unpaid - before3a.seller.unpaid;
  check(
    "kill.in_flight.were_in_flight",
    kill.in_flight_seller_402s === RAIL_IDS.length,
    `seller answered ${kill.in_flight_seller_402s} 402s before the kill`,
  );

  // 3b. With .kill present, every purchase is refused on entry: no request
  // reaches the seller and the signer is never called.
  for (const id of RAIL_IDS) {
    const before = { seller: seller.snapshot(), signer: agents[id].signer.calls };
    const times = [];
    let refused = 0;
    for (let i = 0; i < HALTED_CALLS_PER_RAIL; i += 1) {
      const started = process.hrtime.bigint();
      const r = await agents[id].buy(url("/good"));
      times.push(toMs(process.hrtime.bigint() - started));
      gateSignerInvocations += r.signerInvocations;
      if (r.verdict === "block" && r.reason === "twzrd_kill_switch" && r.signerInvocations === 0) refused += 1;
    }
    const after = seller.snapshot();
    times.sort((a, b) => a - b);
    const entry = {
      rail: id,
      attempts: HALTED_CALLS_PER_RAIL,
      refused_on_entry: refused,
      demo_signer_calls: agents[id].signer.calls - before.signer,
      seller_requests: after.requests - before.seller.requests,
      refusal_ms: { p50: times[Math.floor(times.length / 2)], max: times.at(-1) },
    };
    kill.halted.push(entry);
    check(
      `kill.halted.${id}`,
      refused === HALTED_CALLS_PER_RAIL && entry.demo_signer_calls === 0 && entry.seller_requests === 0,
      `refused ${refused}/${HALTED_CALLS_PER_RAIL} demo_signer=${entry.demo_signer_calls} seller_requests=${entry.seller_requests}`,
    );
  }
  kill.halt_sub_millisecond =
    kill.in_flight.every((e) => e.kill_to_refusal_ms < 1) && kill.halted.every((h) => h.refusal_ms.p50 < 1);

  // 3c. Remove the .kill this run wrote; payments resume on both rails.
  kill.kill_removed = killSwitch.disengage();
  check("kill.removed_own_file", kill.kill_removed, `removed=${kill.kill_removed}`);
  for (const id of RAIL_IDS) {
    const p = await purchase(id, "/good");
    kill.resumed.push(p);
    check(`kill.resumed.${id}`, meets(p, EXPECT.allow), describe(p));
  }

  const final = seller.snapshot();
  const demoSignerCalls = RAIL_IDS.reduce((sum, id) => sum + agents[id].signer.calls, 0);
  const totals = {
    gate_signer_invocations: gateSignerInvocations,
    demo_signer_calls: demoSignerCalls,
    seller_paid: final.paid,
    seller_paid_by_rail: final.paidByRail,
    seller_rejected_payments: final.rejected,
    budget_used_usdc: usdc(budgetUsed()),
    tcp_connections: guard.stats.connections,
    non_loopback_connections_refused: guard.stats.refused,
    non_loopback_targets: guard.stats.refused_targets,
  };
  check(
    "totals.signer_matches_gate",
    demoSignerCalls === gateSignerInvocations && final.paid === demoSignerCalls && final.rejected === 0,
    `demo_signer=${demoSignerCalls} gate=${gateSignerInvocations} seller_paid=${final.paid} rejected=${final.rejected}`,
  );
  check("totals.loopback_only", guard.stats.refused === 0, `non_loopback_refused=${guard.stats.refused}`);

  return {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    node: process.version,
    packages: {
      "twzrd-x402-gate": versionOf("twzrd-x402-gate"),
      "twzrd-receipt-verifier": versionOf("twzrd-receipt-verifier"),
    },
    seller: { origin: seller.origin },
    budget: { agent_id: AGENT_ID, max_spend_usdc: MAX_SPEND },
    acts: { allow, block, kill },
    totals,
    checks,
    result: checks.every((c) => c.pass) ? "pass" : "fail",
  };
}
