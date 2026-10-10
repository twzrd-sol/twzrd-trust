/**
 * 0.12.0: refuseWashUnknown (opt in; default false in 0.12.x, true from 0.13.0).
 * When on, a merchant card on the reputation-scored path that answered but has not
 * fully answered the wash question refuses with twzrd_wash_unknown, the rule
 * wash-default.ts already applies. Off, partial coverage passes as in 0.11.x. An
 * outage stays with failOpen, and the unsupported-network observe path is never
 * refused for coverage.
 *
 * Run: npx tsx test/wash-unknown-default.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { twzrdApprovePayment } from "../src/policy.js";
import type { TwzrdGateConfig } from "../src/types.js";

const SOL_PAYTO = "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC";
const EVM_PAYTO = "0x3803A19280DeeFe533D177C4A169412BD341101b";

type CardReply = { status: number; body?: unknown } | "throw";

function intel(card: CardReply): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/v1/intel/merchant_card/")) {
      if (card === "throw") throw new Error("ECONNREFUSED");
      return new Response(card.body === undefined ? "nope" : JSON.stringify(card.body), {
        status: card.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ readiness_card: { decision: "allow", trust_score: 80, can_spend: true } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

const approve = (card: CardReply, extra: Partial<TwzrdGateConfig> = {}, chain = "solana", payTo = SOL_PAYTO) =>
  twzrdApprovePayment({ payTo, chain, priceUsdc: 0.01 }, resolveConfig({ fetch: intel(card), ...extra }));
const strict = { refuseWashUnknown: true } as const;

async function run() {
  assert.equal(resolveConfig({}).refuseWashUnknown, false, "default off in 0.12.x");
  assert.equal(resolveConfig({ refuseWashUnknown: true }).refuseWashUnknown, true);

  // --- default (off): partial coverage passes as in 0.11.x ---
  {
    const r = await approve({ status: 200, body: { wash_flagged: null, confidence: "partial_inbound_only" } });
    assert.equal(r.approved, true, `default allows partial coverage: ${r.reason}`);
    assert.notEqual(r.reason, "twzrd_wash_unknown");
  }
  console.log("ok  default off: partial coverage is not refused");

  // --- refuses: every shape of "answered, but not fully" ---
  const unknownShapes: Array<[string, CardReply]> = [
    ["partial_inbound_only", { status: 200, body: { wash_flagged: false, confidence: "partial_inbound_only" } }],
    ["base_2cycle", { status: 200, body: { wash_flagged: false, wash_confidence: "base_2cycle" } }],
    ["ring_evaluated false", { status: 200, body: { wash_flagged: false, confidence: "full", ring_evaluated: false } }],
    ["wash_stale", { status: 200, body: { wash_flagged: false, confidence: "full", wash_stale: true } }],
    ["no confidence field", { status: 200, body: { wash_flagged: false, in_corpus: true } }],
    ["4xx (null card)", { status: 404 }],
  ];
  for (const [name, card] of unknownShapes) {
    const r = await approve(card, strict);
    assert.equal(r.approved, false, `${name}: refuses`);
    assert.equal(r.reason, "twzrd_wash_unknown", `${name}: reason`);
    assert.equal(r.verdict, "block", `${name}: verdict`);
    assert.ok(!/unreachable/.test(r.reason), `${name}: never an outage`);
  }
  console.log("ok  opted in: partial / base_2cycle / ring false / stale / no confidence / null card refuse twzrd_wash_unknown");

  // --- allows: full coverage, clean ---
  {
    const r = await approve({ status: 200, body: { wash_flagged: false, confidence: "full" } }, strict);
    assert.equal(r.approved, true, r.reason);
    assert.equal(r.washFlagged, false);
  }
  console.log("ok  full coverage + wash_flagged false allows");

  // --- measured wash keeps its own reason ---
  {
    for (const extra of [{}, strict]) {
      const r = await approve({ status: 200, body: { wash_flagged: true, confidence: "partial_inbound_only" } }, extra);
      assert.equal(r.approved, false);
      assert.equal(r.reason, "twzrd_wash_flagged", "measured wash is wash_flagged, not wash_unknown");
    }
  }
  console.log("ok  wash_flagged true refuses twzrd_wash_flagged");

  // --- opt-in by env; an explicit option wins over env ---
  {
    const partial: CardReply = { status: 200, body: { wash_flagged: false, confidence: "partial_inbound_only" } };
    const prev = process.env.TWZRD_REFUSE_WASH_UNKNOWN;
    process.env.TWZRD_REFUSE_WASH_UNKNOWN = "1";
    try {
      assert.equal(resolveConfig({}).refuseWashUnknown, true, "env 1 turns it on");
      const viaEnv = await approve(partial);
      assert.equal(viaEnv.reason, "twzrd_wash_unknown", `env opt-in refuses: ${viaEnv.reason}`);
      const optionOff = await approve(partial, { refuseWashUnknown: false });
      assert.equal(optionOff.approved, true, `option false overrides env: ${optionOff.reason}`);
    } finally {
      if (prev === undefined) delete process.env.TWZRD_REFUSE_WASH_UNKNOWN;
      else process.env.TWZRD_REFUSE_WASH_UNKNOWN = prev;
    }
  }
  console.log("ok  TWZRD_REFUSE_WASH_UNKNOWN=1 opts in; refuseWashUnknown:false overrides it");

  // --- an outage stays with failOpen ---
  {
    const closed = await approve({ status: 503 }, { failOpen: false, ...strict });
    assert.equal(closed.approved, false);
    assert.match(closed.reason, /^twzrd_card_unreachable_fail_closed/);

    const open = await approve({ status: 503 }, { failOpen: true, ...strict });
    assert.equal(open.approved, true, `failOpen still opens an outage: ${open.reason}`);
    assert.equal(open.cardUnreachable, true);
  }
  console.log("ok  card 503 is an outage: fail-closed by default, failOpen still allows");

  // --- unsupported-network observe path is not refused for coverage ---
  {
    const r = await approve(
      { status: 200, body: { wash_flagged: false, confidence: "partial_inbound_only" } },
      { unsupportedNetworkMode: "observe", ...strict },
      "eip155:137",
      EVM_PAYTO,
    );
    assert.equal(r.approved, true, `observe path: ${r.reason}`);
    assert.notEqual(r.reason, "twzrd_wash_unknown");
  }
  console.log("ok  unsupported network in observe mode is not refused for coverage");

  console.log("wash-unknown-default.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("wash-unknown-default.test.ts FAILED:", e);
  process.exit(1);
});
