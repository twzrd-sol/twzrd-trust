/**
 * Live dogfood: trustless step 3 wash refuse (free only — no USDC spent).
 *
 * Cases:
 *   1. wash_flagged pay_to → refuse (twzrd_wash_flagged) or already preflight-blocked.
 *      Intel's preflight never soft-allows a wash_flagged seller, so live this
 *      is twzrd_decision_block.
 *   2. clean pay_to (wash_flagged=false with full coverage) → approved when
 *      preflight allows. A pay_to with no wash answer is refused as
 *      twzrd_wash_unknown (refuseWashUnknown, the default since 0.13.0).
 *   3. null wash signal still no-invent; a dead intel base reads as unreachable,
 *      not as "no card"; scored-path card outage fail-closes
 *      (`twzrd_card_unreachable_fail_closed`) unless failOpen=true
 *
 * Run from package root:
 *   npx tsx examples/wash-refuse-dogfood.ts
 *   npm run wash-dogfood
 *
 * Env:
 *   TWZRD_INTEL_BASE   default https://intel.twzrd.xyz
 *   WASH_PAYTO         override wash-flagged merchant
 *   CLEAN_PAYTO        override clean / non-wash merchant
 */
import { resolveConfig } from "../src/config.js";
import {
  applyWashFlaggedPolicy,
  fetchMerchantCard,
  fetchMerchantCardResult,
} from "../src/merchant-card.js";
import { twzrdApprovePayment } from "../src/policy.js";

const INTEL = (process.env.TWZRD_INTEL_BASE || "https://intel.twzrd.xyz").replace(/\/+$/, "");

// Fixtures checked live on 2026-11-16 against the free merchant_card and
// preflight. The wash overlay is corpus-derived and moves: every run re-reads
// the card and fails on a fixture that has drifted. Override with WASH_PAYTO /
// CLEAN_PAYTO.
/** wash_flagged=true, preflight block (also wash_flagged in the 2026-07-16 record). */
const DEFAULT_WASH = "HuSiSpcUoUEF4hct1MRsGtNGz8EdBiTs7p2WtJGksLSa";
/** wash_flagged=false with full coverage, preflight allow. */
const DEFAULT_CLEAN = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
/** Alternate wash, tried when the primary card is not flagged: wash_flagged=true, preflight block. */
const ALT_WASH = "DdeMfXrDae49VAkvVZHUhWh7FDuirAuFCuuJruqXv5G2";

type Row = {
  name: string;
  ok: boolean;
  detail: string;
};

function pass(name: string, detail: string): Row {
  return { name, ok: true, detail };
}
function fail(name: string, detail: string): Row {
  return { name, ok: false, detail };
}

async function caseWashRefuse(payTo: string): Promise<Row> {
  const cfg = resolveConfig({
    intelBase: INTEL,
    refuseWashFlagged: true,
    failOpen: true,
    gateOnCanSpend: false,
    // Keep score floor from blocking the pure wash-path demo when preflight is warn@45
    preflightMinScore: 0,
  });
  const card = await fetchMerchantCard(payTo, { intelBase: INTEL, fetch: globalThis.fetch });
  const approval = await twzrdApprovePayment(
    { payTo, priceUsdc: 0.5, agentIntent: "wash_dogfood_refuse" },
    cfg,
  );

  const washOnCard = card?.wash_flagged === true;
  if (!washOnCard) {
    return fail(
      "wash_refuse",
      `expected merchant_card.wash_flagged=true for ${payTo.slice(0, 8)}…; got ${JSON.stringify({
        wash_flagged: card?.wash_flagged ?? null,
        tier: card?.provider_reputation_tier,
        in_corpus: card?.in_corpus,
      })}`,
    );
  }

  // Accept either pure wash refuse, or preflight already blocked (also correct refuse).
  const refused = approval.approved === false;
  const reasonOk =
    approval.reason === "twzrd_wash_flagged" ||
    approval.reason.startsWith("twzrd_wash_flagged_above_cap") ||
    approval.reason.startsWith("twzrd_decision_");

  if (refused && reasonOk) {
    return pass(
      "wash_refuse",
      `approved=false reason=${approval.reason} washFlagged=${approval.washFlagged} verdict=${approval.verdict}`,
    );
  }
  return fail(
    "wash_refuse",
    `expected refuse; got approved=${approval.approved} reason=${approval.reason} washFlagged=${approval.washFlagged}`,
  );
}

async function caseWashCap(payTo: string): Promise<Row> {
  const cfg = resolveConfig({
    intelBase: INTEL,
    refuseWashFlagged: true,
    washMaxUsdc: 0.05,
    failOpen: true,
    gateOnCanSpend: false,
    preflightMinScore: 0,
  });
  const card = await fetchMerchantCard(payTo, { intelBase: INTEL, fetch: globalThis.fetch });
  if (card?.wash_flagged !== true) {
    return fail("wash_cap", `skip/fail: card not wash_flagged for cap demo`);
  }
  const approval = await twzrdApprovePayment(
    { payTo, priceUsdc: 0.01, agentIntent: "wash_dogfood_cap" },
    cfg,
  );
  // If preflight already blocked, cap cannot loosen — only tighten.
  if (!approval.approved && approval.reason.startsWith("twzrd_decision_")) {
    return pass(
      "wash_cap",
      `preflight already blocked (${approval.reason}); cap only tightens — ok`,
    );
  }
  if (approval.approved && approval.washCapped && /twzrd_wash_capped/.test(approval.reason)) {
    return pass(
      "wash_cap",
      `approved under cap reason=${approval.reason} washCapped=${approval.washCapped}`,
    );
  }
  return fail(
    "wash_cap",
    `expected cap-allow or preflight-block; got approved=${approval.approved} reason=${approval.reason}`,
  );
}

async function caseCleanAllow(payTo: string): Promise<Row> {
  const cfg = resolveConfig({
    intelBase: INTEL,
    refuseWashFlagged: true,
    failOpen: true,
    gateOnCanSpend: false,
    preflightMinScore: 0,
  });
  const card = await fetchMerchantCard(payTo, { intelBase: INTEL, fetch: globalThis.fetch });
  if (card?.wash_flagged === true) {
    return fail(
      "clean_allow",
      `CLEAN_PAYTO is wash_flagged; pick a non-wash wallet (got tier=${card?.provider_reputation_tier})`,
    );
  }
  const approval = await twzrdApprovePayment(
    { payTo, priceUsdc: 0.05, agentIntent: "wash_dogfood_clean" },
    cfg,
  );
  if (approval.approved && approval.washFlagged !== true) {
    return pass(
      "clean_allow",
      `approved=true reason=${approval.reason} washFlagged=${approval.washFlagged} card_wash=${card?.wash_flagged ?? null}`,
    );
  }
  return fail(
    "clean_allow",
    `expected allow; approved=${approval.approved} reason=${approval.reason} washFlagged=${approval.washFlagged}`,
  );
}

async function caseCardUnreachable(): Promise<Row> {
  // Pure policy: a missing wash signal must not invent a flag or refuse.
  const wash = applyWashFlaggedPolicy({
    approved: true,
    reason: "twzrd_allow",
    washFlagged: null,
    refuseWashFlagged: true,
    priceUsdc: 0.5,
  });
  if (!(wash.approved && wash.washFlagged === null && wash.reason === "twzrd_allow")) {
    return fail("card_unreachable", `no-invent broken: ${JSON.stringify(wash)}`);
  }
  // A lookup that never completes is an outage, never "no card": fetchMerchantCard
  // throws MerchantCardUnreachableError for it, and the result form says reachable=false.
  const dead = await fetchMerchantCardResult("4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE", {
    intelBase: "https://127.0.0.1:1",
    fetch: globalThis.fetch,
  });
  if (dead.reachable) {
    return fail("card_unreachable", `expected reachable=false from dead base, got ${JSON.stringify(dead)}`);
  }
  // Scored path + card outage honours failOpen (default refuse).
  const intel: typeof fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/v1/intel/preflight")) {
      return new Response(
        JSON.stringify({
          readiness_card: { decision: "allow", trust_score: 80, can_spend: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const closed = await twzrdApprovePayment(
    { payTo: DEFAULT_CLEAN, priceUsdc: 0.05, agentIntent: "wash_dogfood_outage" },
    resolveConfig({ failOpen: false, fetch: intel }),
  );
  if (
    closed.approved ||
    !/^twzrd_card_unreachable_fail_closed/.test(closed.reason ?? "")
  ) {
    return fail(
      "card_unreachable",
      `expected scored-path fail-closed, got approved=${closed.approved} reason=${closed.reason}`,
    );
  }
  return pass(
    "card_unreachable",
    "washFlagged=null keeps prior approve; dead base reads reachable=false; scored outage fail-closes",
  );
}

async function main() {
  const washPayTo = process.env.WASH_PAYTO || DEFAULT_WASH;
  const cleanPayTo = process.env.CLEAN_PAYTO || DEFAULT_CLEAN;

  console.log("wash-refuse-dogfood");
  console.log(`  intelBase=${INTEL}`);
  console.log(`  washPayTo=${washPayTo}`);
  console.log(`  cleanPayTo=${cleanPayTo}`);
  console.log(`  altWash=${ALT_WASH} (hint if primary card not flagged)`);
  console.log("");

  const rows: Row[] = [];
  let washUsed = washPayTo;
  let refuse = await caseWashRefuse(washPayTo);
  if (!refuse.ok && washPayTo === DEFAULT_WASH) {
    console.log(`  retry wash_refuse with alt ${ALT_WASH.slice(0, 8)}…`);
    refuse = await caseWashRefuse(ALT_WASH);
    if (refuse.ok) washUsed = ALT_WASH;
  }
  rows.push(refuse);
  rows.push(await caseWashCap(washUsed));
  rows.push(await caseCleanAllow(cleanPayTo));
  rows.push(await caseCardUnreachable());

  let failed = 0;
  for (const r of rows) {
    const mark = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failed += 1;
    console.log(`[${mark}] ${r.name}: ${r.detail}`);
  }
  console.log("");
  console.log(failed === 0 ? "ALL DOGFOOD CASES PASSED" : `${failed} DOGFOOD CASE(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
