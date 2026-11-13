/**
 * routerProfile: the pinned config for routers that run the gate in-process.
 *
 * - The object is pinned field by field, frozen, and failOpen has no default.
 * - Env variables for the pinned settings cannot move them; the ones it does
 *   not pin are listed and asserted, so a change to that list is deliberate.
 * - Missing evidence does not refuse: an unevaluated seller within its cap and
 *   a reachable card without full wash coverage both pay. A finding refuses:
 *   decision block, a low score, an uncapped warn, a price over the cap, and
 *   wash_flagged true.
 * - The wash refusal is hard: the profile pins washMaxUsdc: null, so
 *   TWZRD_WASH_MAX_USDC on the host cannot pay a wash-flagged seller on any
 *   seat. The same env does pay it on the package defaults, which is the
 *   control that shows the variable is live.
 * - failOpen decides both outages (preflight, merchant card), both ways.
 * - No attribution headers and no payer wallet are sent; the constant client
 *   tag is.
 * - The same answers hold on the seats tested here: createTwzrdBeforePaymentHook,
 *   createTwzrdPayKitBeforePaymentHook, createTwzrdGate, wrapFetchWithTwzrdGate,
 *   withTwzrdGuard and evaluate_x402_resource. The last two used to drop refuseUncappedWarn,
 *   intelTimeoutMs and tripPauseOnBlockMs, so the env or the default applied.
 *
 * Run: npx tsx --test test/router-profile.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.js";
import { evaluate_x402_resource } from "../src/evaluate.js";
import { createTwzrdGate } from "../src/gate.js";
import { routerProfile } from "../src/router-profile.js";
import type { X402PaymentRequirements } from "../src/types.js";
import { withTwzrdGuard } from "../src/with-guard.js";
import { wrapFetchWithTwzrdGate } from "../src/wrap-fetch.js";
import { createTwzrdBeforePaymentHook, createTwzrdPayKitBeforePaymentHook } from "../src/x402-client-hook.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";

type Card = Record<string, unknown>;

const CLEAN = { wash_flagged: false, wash_confidence: "full" };
const FLAGGED = { wash_flagged: true, wash_confidence: "full" };
const PARTIAL = { wash_flagged: false, wash_confidence: "partial_inbound_only" };
/** Live shape of a pubkey intel has never seen (2026-10-25): 200, no wash answer. */
const NEVER_SEEN = { wash_flagged: null, confidence: null, next_action: { decision: "insufficient_evidence" } };

const ALLOW = { decision: "allow", trust_score: 80, can_spend: true };
/** Live shape for a wallet intel has never evaluated (unevaluated-seller.test.ts). */
const UNEVALUATED = {
  decision: "warn",
  trust_score: 45,
  score: null,
  null_reason: "unknown_subject",
  can_spend: true,
  recommended_cap_usdc: 0.1,
};

type Call = { url: string; headers: Record<string, string>; body: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Intel stub. `readiness` or `merchant` set to "down" answers 503 for that route. */
function intel(readiness: Card | "down", merchant: Card | "down" = CLEAN) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.includes("/v1/intel/preflight")) {
      return readiness === "down" ? jsonResponse({ error: "down" }, 503) : jsonResponse({ readiness_card: readiness });
    }
    if (url.includes("/v1/intel/merchant_card/")) {
      return merchant === "down" ? jsonResponse({ error: "down" }, 503) : jsonResponse(merchant);
    }
    throw new Error(`unexpected intel url ${url}`);
  }) as unknown as typeof fetch & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

/** micro-USDC: "10000" is 0.01. */
const req = (amount: string) => ({ payTo: SELLER, network: SOL, amount, asset: USDC, resource: "https://merchant.example/paid" });

const PINNED_ENV = [
  "TWZRD_FAIL_OPEN",
  "TWZRD_REFUSE_UNEVALUATED",
  "TWZRD_REFUSE_WASH_UNKNOWN",
  "TWZRD_REFUSE_WASH_FLAGGED",
  "TWZRD_WASH_MAX_USDC",
  "TWZRD_REFUSE_UNCAPPED_WARN",
  "TWZRD_PREFLIGHT_MIN_SCORE",
  "TWZRD_BLOCK_DECISIONS",
  "TWZRD_GATE_ON_CAN_SPEND",
  "TWZRD_UNSUPPORTED_NETWORK_MODE",
  "TWZRD_INTEL_TIMEOUT_MS",
] as const;

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const prev = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every pinned env variable set to the value that would move it. */
const HOSTILE_ENV: Record<(typeof PINNED_ENV)[number], string> = {
  TWZRD_FAIL_OPEN: "true",
  TWZRD_REFUSE_UNEVALUATED: "1",
  TWZRD_REFUSE_WASH_UNKNOWN: "1",
  TWZRD_REFUSE_WASH_FLAGGED: "0",
  // Far above every price in this file: it would pay any wash-flagged seller here.
  TWZRD_WASH_MAX_USDC: "1000",
  TWZRD_REFUSE_UNCAPPED_WARN: "0",
  TWZRD_PREFLIGHT_MIN_SCORE: "95",
  TWZRD_BLOCK_DECISIONS: "block,warn",
  TWZRD_GATE_ON_CAN_SPEND: "true",
  TWZRD_UNSUPPORTED_NETWORK_MODE: "strict",
  TWZRD_INTEL_TIMEOUT_MS: "5",
};

const FETCH_SEAT_REQS = {
  payTo: SELLER,
  maxAmountRequired: "10000",
  resource: "https://merchant.example/paid",
  network: "solana",
  asset: USDC,
} as X402PaymentRequirements;
const fetchSeat402 = (async () =>
  jsonResponse({ x402Version: 1, error: "payment_required", accepts: [{ ...FETCH_SEAT_REQS, scheme: "exact" }] }, 402)) as unknown as typeof fetch;
const PAID_URL = "https://merchant.example/paid";

const aborted = (r: { abort?: boolean; reason?: string } | void | undefined) => Boolean(r && r.abort === true);
const reasonOf = (r: { reason?: string } | void | undefined) => String(r?.reason ?? "");

test("the profile object is pinned, frozen, and has no failOpen default", () => {
  for (const failOpen of [true, false]) {
    const p = routerProfile({ failOpen });
    assert.deepEqual(
      { ...p, blockDecisions: [...p.blockDecisions] },
      {
        failOpen,
        refuseUnevaluated: false,
        refuseWashUnknown: false,
        refuseWashFlagged: true,
        washMaxUsdc: null,
        refuseUncappedWarn: true,
        preflightMinScore: 40,
        blockDecisions: ["block"],
        gateOnCanSpend: false,
        unsupportedNetworkMode: "observe",
        intelTimeoutMs: 2000,
      },
    );
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.blockDecisions));
    assert.equal("attribution" in p, false, "the profile never sets attribution");
    assert.equal(p.washMaxUsdc, null, "an explicit null, not a missing key: resolveConfig reads the env for a missing one");
  }
  for (const bad of [undefined, null, {}, { failOpen: "true" }, { failOpen: 1 }, { failOpen: undefined }]) {
    assert.throws(() => routerProfile(bad as never), TypeError, `rejects ${JSON.stringify(bad)}`);
  }
  // Spread to override; the copy is a plain config.
  const tuned = { ...routerProfile({ failOpen: true }), intelTimeoutMs: 800 };
  assert.equal(resolveConfig(tuned).intelTimeoutMs, 800);
});

test("env variables for pinned settings do not move the resolved profile", async () => {
  for (const failOpen of [true, false]) {
    const resolved = await withEnv(failOpen ? { ...HOSTILE_ENV, TWZRD_FAIL_OPEN: "false" } : HOSTILE_ENV, () =>
      resolveConfig(routerProfile({ failOpen })),
    );
    assert.equal(resolved.failOpen, failOpen);
    assert.equal(resolved.refuseUnevaluated, false);
    assert.equal(resolved.refuseWashUnknown, false);
    assert.equal(resolved.refuseWashFlagged, true);
    assert.equal(resolved.washMaxUsdc, null, "TWZRD_WASH_MAX_USDC=1000 does not become a soft cap");
    assert.equal(resolved.refuseUncappedWarn, true);
    assert.equal(resolved.preflightMinScore, 40);
    assert.deepEqual([...resolved.blockDecisions], ["block"]);
    assert.equal(resolved.gateOnCanSpend, false);
    assert.equal(resolved.unsupportedNetworkMode, "observe");
    assert.equal(resolved.intelTimeoutMs, 2000);
  }
});

test("operator settings the profile does not pin still reach it", async () => {
  // Listed in router-profile.ts and the README. Each is inert unless set.
  const resolved = await withEnv(
    {
      TWZRD_INTEL_BASE: "https://intel.example",
      TWZRD_ATTRIBUTION_INTEGRATION: "router-x",
      TWZRD_ATTRIBUTION_RUN_ID: "run-1",
      TWZRD_TRIP_PAUSE_ON_BLOCK_MS: "60000",
    },
    () => resolveConfig(routerProfile({ failOpen: false })),
  );
  assert.equal(resolved.intelBase, "https://intel.example");
  assert.deepEqual(resolved.attribution, { integration: "router-x", runId: "run-1" });
  assert.equal(resolved.tripPauseOnBlockMs, 60000);
  const plain = resolveConfig(routerProfile({ failOpen: false }));
  assert.equal(plain.attribution, undefined);
  assert.equal(plain.tripPauseOnBlockMs, undefined);
});

test("a soft wash cap is a code override on the profile, never the env variable", async () => {
  const flagged = () => intel(ALLOW, FLAGGED);
  // The router writes the cap itself: at or under it pays, above it refuses.
  const tuned = { ...routerProfile({ failOpen: false }), washMaxUsdc: 0.02 };
  assert.equal(resolveConfig(tuned).washMaxUsdc, 0.02);
  const under = await createTwzrdBeforePaymentHook({ ...tuned, fetch: flagged() })(req("10000"));
  assert.equal(aborted(under), false, reasonOf(under));
  const over = await createTwzrdBeforePaymentHook({ ...tuned, fetch: flagged() })(req("50000"));
  assert.equal(aborted(over), true);
  assert.match(reasonOf(over), /twzrd_wash_flagged/);
  // The written cap also beats a looser env value.
  await withEnv({ TWZRD_WASH_MAX_USDC: "1000" }, async () => {
    assert.equal(resolveConfig(tuned).washMaxUsdc, 0.02);
    const stillOver = await createTwzrdBeforePaymentHook({ ...tuned, fetch: flagged() })(req("50000"));
    assert.equal(aborted(stillOver), true);
  });
});

test("TWZRD_WASH_MAX_USDC cannot pay a wash-flagged seller on any seat", async () => {
  const profile = routerProfile({ failOpen: false });
  const ctx = { payTo: SELLER, chain: SOL, priceUsdc: 0.01, asset: USDC };
  const clientCtx = { selectedRequirements: req("10000") };
  await withEnv({ TWZRD_WASH_MAX_USDC: "1000" }, async () => {
    // Control: on the package defaults the same env pays the same seller, so
    // the refusals below come from the pinned null and not from a dead variable.
    const control = await createTwzrdBeforePaymentHook({ fetch: intel(ALLOW, FLAGGED) })(req("10000"));
    assert.equal(aborted(control), false, `env soft cap is live on the defaults: ${reasonOf(control)}`);
    const controlGate = await createTwzrdGate({ fetch: intel(ALLOW, FLAGGED) }).approvePayment(ctx);
    assert.equal(controlGate.approved, true);
    assert.match(controlGate.reason, /twzrd_wash_capped_0\.01_le_1000/);

    const hook = await createTwzrdBeforePaymentHook({ ...profile, fetch: intel(ALLOW, FLAGGED) })(req("10000"));
    assert.equal(aborted(hook), true, "createTwzrdBeforePaymentHook");
    assert.match(reasonOf(hook), /twzrd_wash_flagged/);

    const payKit = await createTwzrdPayKitBeforePaymentHook({ ...profile, fetch: intel(ALLOW, FLAGGED) })(clientCtx as never);
    assert.equal(aborted(payKit), true, "createTwzrdPayKitBeforePaymentHook");
    assert.match(reasonOf(payKit), /twzrd_wash_flagged/);

    const gate = await createTwzrdGate({ ...profile, fetch: intel(ALLOW, FLAGGED) }).approvePayment(ctx);
    assert.equal(gate.approved, false, "createTwzrdGate");
    assert.equal(gate.reason, "twzrd_wash_flagged");

    await assert.rejects(
      () => wrapFetchWithTwzrdGate(fetchSeat402, resolveConfig({ ...profile, fetch: intel(ALLOW, FLAGGED) }))(PAID_URL),
      /twzrd_wash_flagged/,
      "wrapFetchWithTwzrdGate",
    );
    // withTwzrdGuard resolves the config and then calls evaluate_x402_resource,
    // which resolves again; the null has to survive that second hop.
    await assert.rejects(
      () => withTwzrdGuard(fetchSeat402, { ...profile, fetch: intel(ALLOW, FLAGGED) })(PAID_URL),
      /twzrd_wash_flagged/,
      "withTwzrdGuard",
    );
    const evaluated = await evaluate_x402_resource(PAID_URL, FETCH_SEAT_REQS, { ...profile, fetch: intel(ALLOW, FLAGGED) });
    assert.equal(evaluated.approved, false, "evaluate_x402_resource");
    assert.equal(evaluated.reason, "twzrd_wash_flagged");

    // An unevaluated seller within its own cap is paid on the profile, but not
    // when it is wash-flagged, env or no env.
    const unevaluated = await createTwzrdBeforePaymentHook({ ...profile, fetch: intel(UNEVALUATED, FLAGGED) })(req("10000"));
    assert.equal(aborted(unevaluated), true);
    assert.match(reasonOf(unevaluated), /twzrd_wash_flagged/);
  });
});

test("missing evidence pays; the same calls refuse on the package defaults", async () => {
  const profile = routerProfile({ failOpen: false });
  // Unevaluated seller within its cap, merchant card that has never seen it.
  const unevaluated = await createTwzrdBeforePaymentHook({ ...profile, fetch: intel(UNEVALUATED, NEVER_SEEN) })(req("10000"));
  assert.equal(aborted(unevaluated), false, reasonOf(unevaluated));
  const unevaluatedDefault = await createTwzrdBeforePaymentHook({ fetch: intel(UNEVALUATED, NEVER_SEEN) })(req("10000"));
  assert.equal(aborted(unevaluatedDefault), true);
  assert.match(reasonOf(unevaluatedDefault), /twzrd_unevaluated_subject_unknown_subject/);

  // Evaluated allow, card reachable with partial coverage.
  const partial = await createTwzrdBeforePaymentHook({ ...profile, fetch: intel(ALLOW, PARTIAL) })(req("10000"));
  assert.equal(aborted(partial), false, reasonOf(partial));
  const partialDefault = await createTwzrdBeforePaymentHook({ fetch: intel(ALLOW, PARTIAL) })(req("10000"));
  assert.equal(aborted(partialDefault), true);
  assert.match(reasonOf(partialDefault), /twzrd_wash_unknown/);

  // The hostile env does not turn either refusal back on.
  await withEnv(HOSTILE_ENV, async () => {
    const viaEnv = await createTwzrdBeforePaymentHook({ ...profile, fetch: intel(UNEVALUATED, NEVER_SEEN) })(req("10000"));
    assert.equal(aborted(viaEnv), false, reasonOf(viaEnv));
  });
});

test("findings still refuse before the signer", async () => {
  const profile = routerProfile({ failOpen: true });
  const cases: Array<[string, Card, Card, string, RegExp]> = [
    ["decision block", { decision: "block", trust_score: 9, can_spend: false }, CLEAN, "10000", /twzrd_decision_block/],
    ["score below 40", { decision: "allow", trust_score: 30, can_spend: true }, CLEAN, "10000", /twzrd_score_30_below_40/],
    ["warn without a cap", { decision: "warn", trust_score: 50, can_spend: true }, CLEAN, "10000", /twzrd_warn_no_cap/],
    ["warn over its cap", { decision: "warn", trust_score: 50, can_spend: true, recommended_cap_usdc: 0.01 }, CLEAN, "20000", /twzrd_over_recommended_cap_0\.02_gt_0\.01/],
    ["unevaluated over its cap", UNEVALUATED, NEVER_SEEN, "200000", /twzrd_unevaluated_over_cap_0\.2_gt_0\.1/],
    ["unevaluated without a cap", { ...UNEVALUATED, recommended_cap_usdc: null }, NEVER_SEEN, "10000", /twzrd_unevaluated_no_cap_unknown_subject/],
    ["wash flagged, evaluated", ALLOW, FLAGGED, "10000", /twzrd_wash_flagged/],
    ["wash flagged, unevaluated within cap", UNEVALUATED, FLAGGED, "10000", /twzrd_wash_flagged/],
  ];
  for (const [name, card, merchant, amount, reason] of cases) {
    const r = await createTwzrdBeforePaymentHook({ ...profile, fetch: intel(card, merchant) })(req(amount));
    assert.equal(aborted(r), true, `${name} aborts`);
    assert.match(reasonOf(r), reason, name);
  }
  // A wash flag on an unscored network still refuses; the network itself does not.
  const polygon = { ...req("10000"), network: "eip155:137", payTo: "0x1111111111111111111111111111111111111111", asset: undefined };
  const unscoredClean = await createTwzrdBeforePaymentHook({ ...profile, fetch: intel(ALLOW, CLEAN) })(polygon);
  assert.equal(aborted(unscoredClean), false, reasonOf(unscoredClean));
  const unscoredFlagged = await createTwzrdBeforePaymentHook({ ...profile, fetch: intel(ALLOW, FLAGGED) })(polygon);
  assert.equal(aborted(unscoredFlagged), true);
  assert.match(reasonOf(unscoredFlagged), /twzrd_wash_flagged/);
});

test("failOpen decides both outages, both ways", async () => {
  for (const [readiness, merchant, closedReason] of [
    ["down", CLEAN, /twzrd_fail_closed/],
    [ALLOW, "down", /twzrd_card_unreachable_fail_closed/],
  ] as const) {
    const open = await createTwzrdBeforePaymentHook({ ...routerProfile({ failOpen: true }), fetch: intel(readiness, merchant) })(req("10000"));
    assert.equal(aborted(open), false, reasonOf(open));
    const closed = await createTwzrdBeforePaymentHook({ ...routerProfile({ failOpen: false }), fetch: intel(readiness, merchant) })(req("10000"));
    assert.equal(aborted(closed), true);
    assert.match(reasonOf(closed), closedReason);
  }
});

test("no attribution headers and no payer wallet go to intel", async () => {
  const stub = intel(ALLOW, CLEAN);
  const r = await createTwzrdBeforePaymentHook({ ...routerProfile({ failOpen: false }), fetch: stub })(req("10000"));
  assert.equal(aborted(r), false, reasonOf(r));
  const preflight = stub.calls.find((c) => c.url.includes("/v1/intel/preflight"));
  assert.ok(preflight, "preflight was called");
  assert.match(preflight.headers["x-twzrd-client"] ?? "", /^twzrd-x402-gate\//, "the constant client tag is sent");
  assert.equal(preflight.headers["x-twzrd-caller"], preflight.headers["x-twzrd-client"]);
  assert.equal(preflight.headers["x-twzrd-integration"], undefined);
  assert.equal(preflight.headers["x-twzrd-run-id"], undefined);
  assert.equal((preflight.body as Record<string, unknown>).buyer_wallet, undefined);
  const card = stub.calls.find((c) => c.url.includes("/v1/intel/merchant_card/"));
  assert.ok(card, "merchant card was called");
  assert.deepEqual(
    Object.keys(card.headers).filter((h) => h.startsWith("x-twzrd")),
    [],
    "the merchant card call carries no TWZRD header",
  );
  assert.deepEqual(
    stub.calls.map((c) => new URL(c.url).pathname.split("/").slice(0, 4).join("/")),
    ["/v1/intel/preflight", "/v1/intel/merchant_card"],
    "two free intel calls, no paid hop",
  );
});

test("the other full-config seats give the same answers", async () => {
  const profile = routerProfile({ failOpen: false });
  const ctx = { payTo: SELLER, chain: SOL, priceUsdc: 0.01, asset: USDC };

  // createTwzrdGate / twzrdApprovePayment
  const gatePays = await createTwzrdGate({ ...profile, fetch: intel(UNEVALUATED, NEVER_SEEN) }).approvePayment(ctx);
  assert.equal(gatePays.approved, true, gatePays.reason);
  const gateRefuses = await createTwzrdGate({ ...profile, fetch: intel(UNEVALUATED, FLAGGED) }).approvePayment(ctx);
  assert.equal(gateRefuses.approved, false);
  assert.equal(gateRefuses.reason, "twzrd_wash_flagged");

  // createTwzrdPayKitBeforePaymentHook: the context shape an x402Client's
  // onBeforePaymentCreation and PayKit's onBeforeX402PaymentCreation pass.
  const clientCtx = { selectedRequirements: req("10000") };
  const clientPays = await createTwzrdPayKitBeforePaymentHook({ ...profile, fetch: intel(UNEVALUATED, NEVER_SEEN) })(clientCtx as never);
  assert.equal(aborted(clientPays), false, reasonOf(clientPays));
  const clientRefuses = await createTwzrdPayKitBeforePaymentHook({ ...profile, fetch: intel(UNEVALUATED, FLAGGED) })(clientCtx as never);
  assert.equal(aborted(clientRefuses), true);
  assert.match(reasonOf(clientRefuses), /twzrd_wash_flagged/);

  // A 402 from the resource, for the fetch seats.
  const resource402 = (async () =>
    jsonResponse(
      {
        x402Version: 1,
        error: "payment_required",
        accepts: [{ scheme: "exact", network: "solana", maxAmountRequired: "10000", resource: "https://merchant.example/paid", payTo: SELLER, asset: USDC }],
      },
      402,
    )) as unknown as typeof fetch;

  // wrapFetchWithTwzrdGate
  const wrapPays = await wrapFetchWithTwzrdGate(resource402, resolveConfig({ ...profile, fetch: intel(UNEVALUATED, NEVER_SEEN) }))("https://merchant.example/paid");
  assert.equal(wrapPays.status, 402, "the 402 is handed back for the payer");
  await assert.rejects(
    () => wrapFetchWithTwzrdGate(resource402, resolveConfig({ ...profile, fetch: intel(UNEVALUATED, FLAGGED) }))("https://merchant.example/paid"),
    /twzrd_wash_flagged/,
  );

  // withTwzrdGuard
  const guardPays = await withTwzrdGuard(resource402, { ...profile, fetch: intel(UNEVALUATED, NEVER_SEEN) })("https://merchant.example/paid");
  assert.equal(guardPays.status, 402);
  await assert.rejects(
    () => withTwzrdGuard(resource402, { ...profile, fetch: intel(ALLOW, FLAGGED) })("https://merchant.example/paid"),
    /twzrd_wash_flagged/,
  );

  // evaluate_x402_resource
  const reqs = { payTo: SELLER, maxAmountRequired: "10000", resource: "https://merchant.example/paid", network: "solana", asset: USDC } as X402PaymentRequirements;
  const evalPays = await evaluate_x402_resource("https://merchant.example/paid", reqs, { ...profile, fetch: intel(UNEVALUATED, NEVER_SEEN) });
  assert.equal(evalPays.approved, true, evalPays.reason);
  const evalPartial = await evaluate_x402_resource("https://merchant.example/paid", reqs, { ...profile, fetch: intel(ALLOW, PARTIAL) });
  assert.equal(evalPartial.approved, true, `partial coverage pays here too: ${evalPartial.reason}`);
  const evalFlagged = await evaluate_x402_resource("https://merchant.example/paid", reqs, { ...profile, fetch: intel(ALLOW, FLAGGED) });
  assert.equal(evalFlagged.approved, false);
  assert.equal(evalFlagged.reason, "twzrd_wash_flagged");
});

test("withTwzrdGuard and evaluate_x402_resource pass refuseUncappedWarn through", async () => {
  const warn = { decision: "warn", trust_score: 50, can_spend: true };
  // The pinned true holds against the env opt-out (it used to be dropped, so the env won).
  await withEnv({ TWZRD_REFUSE_UNCAPPED_WARN: "0" }, async () => {
    const e = await evaluate_x402_resource(PAID_URL, FETCH_SEAT_REQS, { ...routerProfile({ failOpen: false }), fetch: intel(warn) });
    assert.equal(e.approved, false);
    assert.match(e.reason, /twzrd_warn_no_cap/);
    await assert.rejects(
      () => withTwzrdGuard(fetchSeat402, { ...routerProfile({ failOpen: false }), fetch: intel(warn) })(PAID_URL),
      /twzrd_warn_no_cap/,
    );
  });
  // An explicit false is honoured (it used to be dropped, so the default refused).
  const optOut = await evaluate_x402_resource(PAID_URL, FETCH_SEAT_REQS, { refuseUncappedWarn: false, fetch: intel(warn) });
  assert.equal(optOut.approved, true, optOut.reason);
  const guardOptOut = await withTwzrdGuard(fetchSeat402, { refuseUncappedWarn: false, fetch: intel(warn) })(PAID_URL);
  assert.equal(guardOptOut.status, 402);
});

test("withTwzrdGuard and evaluate_x402_resource pass intelTimeoutMs through", async () => {
  const hung = (async (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  for (const seat of ["evaluate", "guard"] as const) {
    const opts = { ...routerProfile({ failOpen: false }), intelTimeoutMs: 50, fetch: hung };
    const started = Date.now();
    if (seat === "evaluate") {
      const r = await evaluate_x402_resource(PAID_URL, FETCH_SEAT_REQS, opts);
      assert.equal(r.approved, false);
      assert.match(r.reason, /twzrd_fail_closed/);
    } else {
      await assert.rejects(() => withTwzrdGuard(fetchSeat402, opts)(PAID_URL), /twzrd_fail_closed/);
    }
    assert.ok(Date.now() - started < 1500, `${seat}: the 50 ms deadline applied, not the 2000 ms default`);
  }
});

test("withTwzrdGuard and evaluate_x402_resource pass tripPauseOnBlockMs through", async () => {
  // Opt-in and not part of the profile; a fatal refusal writes .pause when set.
  for (const seat of ["evaluate", "guard"] as const) {
    const stateDir = mkdtempSync(path.join(tmpdir(), "router-profile-"));
    try {
      const opts = {
        ...routerProfile({ failOpen: false }),
        stateDir,
        tripPauseOnBlockMs: 60_000,
        fetch: intel({ decision: "block", trust_score: 9, can_spend: false }),
      };
      if (seat === "evaluate") {
        const r = await evaluate_x402_resource(PAID_URL, FETCH_SEAT_REQS, opts);
        assert.equal(r.approved, false);
      } else {
        await assert.rejects(() => withTwzrdGuard(fetchSeat402, opts)(PAID_URL), /twzrd_decision_block/);
      }
      assert.ok(existsSync(path.join(stateDir, ".pause")), `${seat}: the opted-in pause was written`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
});
