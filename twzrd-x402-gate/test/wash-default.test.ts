/**
 * Product wash-default path — merchant_card only, fail-closed on outage, no Path A.
 * Run: npx tsx test/wash-default.test.ts
 */
import assert from "node:assert/strict";

import {
  createTwzrdPayingClient,
  createTwzrdWashBeforePaymentHook,
  evaluateWashOnlyBeforePayment,
  isWashCoverageAdequate,
  washEvidenceFromCard,
} from "../src/wash-default.js";
import {
  createTwzrdBeforePaymentHook,
} from "../src/x402-client-hook.js";
import { CLIENT_VERSION } from "../src/version.js";

const WASH = "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC";
const CLEAN = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";

function cardFetch(body: unknown, status = 200): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    assert.match(url, /\/v1\/intel\/merchant_card\//, `unexpected URL ${url}`);
    assert.ok(!url.includes("/v1/intel/preflight"), "must not hit preflight");
    assert.ok(!url.includes("/v1/intel/trust/"), "must not hit Path A trust");
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function downFetch(): typeof fetch {
  return (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

function non2xxFetch(): typeof fetch {
  return (async () =>
    new Response("nope", { status: 503 })) as unknown as typeof fetch;
}

async function run() {
  // wash_flagged true → abort
  {
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: WASH, amount: "50000" },
      { fetch: cardFetch({ wash_flagged: true }) },
    );
    assert.ok(r && r.abort === true);
    assert.match(r.reason, /twzrd_wash_flagged/);
  }

  // adequately measured clean → proceed
  {
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: CLEAN, amount: "50000" },
      { fetch: cardFetch({ wash_flagged: false, wash_confidence: "full" }) },
    );
    assert.equal(r, undefined);
  }

  // missing wash signal on a returned card → unknown, not twzrd_wash_ok
  {
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: CLEAN, amount: "1" },
      { fetch: cardFetch({ in_corpus: true }) },
    );
    assert.ok(r && r.abort === true);
    assert.match(r.reason, /twzrd_wash_unknown/);
    assert.doesNotMatch(r.reason, /twzrd_wash_ok/);
  }

  // wash_flagged false without coverage → unknown
  {
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: CLEAN, amount: "1" },
      { fetch: cardFetch({ wash_flagged: false }) },
    );
    assert.ok(r && r.abort === true);
    assert.match(r.reason, /twzrd_wash_unknown/);
  }

  // Base 2-cycle half-screen → unknown
  {
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: CLEAN, amount: "1" },
      {
        fetch: cardFetch({
          wash_flagged: false,
          wash_confidence: "base_2cycle",
        }),
      },
    );
    assert.ok(r && r.abort === true);
    assert.match(r.reason, /twzrd_wash_unknown/);
  }

  // unevaluated ring → unknown
  {
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: CLEAN, amount: "1" },
      {
        fetch: cardFetch({
          wash_flagged: false,
          ring_evaluated: false,
        }),
      },
    );
    assert.ok(r && r.abort === true);
    assert.match(r.reason, /twzrd_wash_unknown/);
  }

  // stale overlay → unknown
  {
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: CLEAN, amount: "1" },
      {
        fetch: cardFetch({
          wash_flagged: false,
          wash_confidence: "full",
          wash_stale: true,
        }),
      },
    );
    assert.ok(r && r.abort === true);
    assert.match(r.reason, /twzrd_wash_unknown/);
  }

  // corpus-age stale is a warning, not a wash refuse
  {
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: CLEAN, amount: "50000" },
      {
        fetch: cardFetch({
          wash_flagged: false,
          wash_confidence: "full",
          stale: true,
          corpus_complete_day: "2026-07-09",
          corpus_age_days: 71,
        }),
      },
    );
    assert.equal(r, undefined);
  }

  // network throw → fail-closed (intel outage is not a missing wash signal)
  {
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: WASH, amount: "1" },
      { fetch: downFetch() },
    );
    assert.ok(r && r.abort === true);
    assert.match(r.reason, /^twzrd_card_unreachable_fail_closed/);
  }

  // 503 → fail-closed
  {
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: WASH, amount: "1" },
      { fetch: non2xxFetch() },
    );
    assert.ok(r && r.abort === true);
    assert.match(r.reason, /http_503/);
  }

  // same outages proceed only when failOpen is opted in
  {
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: WASH, amount: "1" },
      { fetch: downFetch(), failOpen: true },
    );
    assert.equal(r, undefined);
  }

  // createTwzrdWashBeforePaymentHook (product default paying path)
  {
    let signed = false;
    const hook = createTwzrdWashBeforePaymentHook({
      fetch: cardFetch({ wash_flagged: true }),
    });
    const decision = await hook(
      { payTo: WASH, amount: "50000", network: "solana" },
      { requestUrl: "https://m.example/paid" },
    );
    assert.ok(decision && decision.abort === true);
    assert.equal(signed, false);
  }

  // createTwzrdPayingClient drop-in
  {
    const wallet = { publicKey: "buyer" };
    const cfg = createTwzrdPayingClient({
      wallet,
      fetch: cardFetch({ wash_flagged: true }),
    });
    assert.equal(cfg.wallet, wallet);
    assert.equal(cfg.network, "solana");
    assert.equal(cfg.twzrdGate.engine, "wash");
    assert.equal(cfg.twzrdGate.version, CLIENT_VERSION);
    const decision = await cfg.beforePayment(
      { payTo: WASH, maxAmountRequired: "50000", network: "solana" },
      { requestUrl: "https://m.example/paid", declaredResource: { url: "https://m.example/paid" } },
    );
    assert.ok(decision && decision.abort === true);
  }

  // full engine still callable (hits preflight path — mock both)
  {
    const calls: string[] = [];
    const fetchBoth = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("merchant_card")) {
        return new Response(
          JSON.stringify({ wash_flagged: false, wash_confidence: "full" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          readiness_card: {
            decision: "allow",
            trust_score: 80,
            can_spend: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const full = createTwzrdBeforePaymentHook({
      fetch: fetchBoth,
      refuseWashFlagged: true,
      failOpen: true,
      gateOnCanSpend: false,
    });
    const decision = await full(
      { payTo: CLEAN, amount: "1000", network: "solana" },
      { requestUrl: "https://m.example/ok" },
    );
    assert.equal(decision, undefined);
    assert.ok(
      calls.some((u) => u.includes("preflight") || u.includes("merchant_card")),
      `full engine should call intel; got ${calls.join(",")}`,
    );
  }

  // wash hook never calls preflight even when wash false
  {
    const calls: string[] = [];
    const fetchSpy = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({ wash_flagged: false, wash_confidence: "full" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    await createTwzrdWashBeforePaymentHook({ fetch: fetchSpy })(
      { payTo: CLEAN, amount: "1" },
      {},
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /merchant_card/);
  }

  // wash-allow: bind decision must not mutate the LIVE selected object
  {
    const req: Record<string, unknown> = {
      payTo: CLEAN,
      amount: "10000",
      network: "solana",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      resource: "https://m.example/paid",
    };
    const hook = createTwzrdWashBeforePaymentHook({
      fetch: cardFetch({ wash_flagged: false, wash_confidence: "full" }),
    });
    const decision = await hook(req, { requestUrl: "https://m.example/paid" });
    assert.equal(decision, undefined);
    assert.equal(req.extra, undefined);
  }

  // wash-allow: never overwrite seller extra.memo
  {
    const req: Record<string, unknown> = {
      payTo: CLEAN,
      amount: "10000",
      network: "solana",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      resource: "https://m.example/paid",
      extra: { memo: "seller-memo" },
    };
    const hook = createTwzrdWashBeforePaymentHook({
      fetch: cardFetch({ wash_flagged: false, wash_confidence: "full" }),
    });
    const decision = await hook(req, { requestUrl: "https://m.example/paid" });
    assert.equal(decision, undefined);
    const extra = req.extra as { memo?: string; twzrd_resource_bind?: string };
    assert.equal(extra.memo, "seller-memo");
    assert.equal(extra.twzrd_resource_bind, undefined);
  }

  // wash-refuse: abort BEFORE any stamp
  {
    const req: Record<string, unknown> = {
      payTo: WASH,
      amount: "50000",
      network: "solana",
      resource: "https://m.example/paid",
    };
    const hook = createTwzrdWashBeforePaymentHook({
      fetch: cardFetch({ wash_flagged: true }),
    });
    const decision = await hook(req, { requestUrl: "https://m.example/paid" });
    assert.ok(decision && decision.abort === true);
    assert.equal(req.extra, undefined);
  }

  // signer counter: measured wash → abort, invocations stay 0
  {
    let signerInvocations = 0;
    const hook = createTwzrdWashBeforePaymentHook({
      fetch: cardFetch({ wash_flagged: true }),
    });
    const decision = await hook(
      { payTo: WASH, amount: "50000", network: "solana" },
      { requestUrl: "https://m.example/paid" },
    );
    if (!(decision && decision.abort)) signerInvocations += 1;
    assert.equal(signerInvocations, 0);
    assert.ok(decision && decision.abort === true);
    assert.match(decision.reason, /twzrd_wash_flagged/);
  }

  // signer counter: null flag → unknown, not twzrd_wash_ok, invocations stay 0
  {
    let signerInvocations = 0;
    const seen: string[] = [];
    const hook = createTwzrdWashBeforePaymentHook({
      fetch: cardFetch({ wash_flagged: null }),
      onDecision: (d) => {
        seen.push(d.reason);
      },
    });
    const decision = await hook(
      { payTo: CLEAN, amount: "1000", network: "solana" },
      { requestUrl: "https://m.example/paid" },
    );
    if (!(decision && decision.abort)) signerInvocations += 1;
    assert.equal(signerInvocations, 0);
    assert.ok(decision && decision.abort === true);
    assert.match(decision.reason, /twzrd_wash_unknown/);
    assert.equal(seen.some((r) => r === "twzrd_wash_ok"), false);
  }

  // signer counter: positive control — adequate no-signal increments
  {
    let signerInvocations = 0;
    const hook = createTwzrdWashBeforePaymentHook({
      fetch: cardFetch({ wash_flagged: false, wash_confidence: "full" }),
    });
    const decision = await hook(
      { payTo: CLEAN, amount: "1000", network: "solana" },
      { requestUrl: "https://m.example/paid" },
    );
    if (!(decision && decision.abort)) signerInvocations += 1;
    assert.equal(decision, undefined);
    assert.equal(signerInvocations, 1);
  }

  console.log("wash-default.test.ts: ok");
}

/**
 * merchant_card_v1.6 renamed `wash_confidence` to `confidence` and moved the
 * ring flag under `circular_flow_signals`. Reading only the old names made
 * every v1.6 seller look unmeasured, and unmeasured is correctly treated as
 * not-clean — so a field rename refused the whole rail instead of a bad
 * seller. These bodies are verbatim from the live endpoints on 2026-09-15.
 */
async function runV16SchemaRegression() {
  // Verbatim GET /v1/intel/merchant_card/0x9D3d9410... (HTTP twin).
  const httpV16 = {
    merchant: "0x9d3d9410be95fa1d230734b961997427fc61d837",
    wash_flagged: false,
    confidence: "full",
    card_version: "merchant_card_v1.6",
  };
  const ev = washEvidenceFromCard(httpV16);
  assert.equal(ev.washFlagged, false);
  assert.equal(ev.washConfidence, "full", "v1.6 `confidence` must be read");
  assert.equal(isWashCoverageAdequate(ev), true, "a v1.6 card must not read as unmeasured");

  // Verbatim MCP get_merchant_card shape: legacy name plus a nested ring flag.
  const mcpV16 = {
    merchant: "0x9d3d9410be95fa1d230734b961997427fc61d837",
    wash_flagged: false,
    wash_confidence: "full",
    circular_flow_signals: { self: 0, reciprocal: 0, ring: 0, ring_evaluated: true },
    card_version: "merchant_card_v1.6",
  };
  const ev2 = washEvidenceFromCard(mcpV16);
  assert.equal(ev2.washConfidence, "full");
  assert.equal(ev2.ringEvaluated, true, "the nested ring flag must be read");
  assert.equal(isWashCoverageAdequate(ev2), true);

  // The legacy name still wins, so an older server keeps its exact meaning.
  const both = { wash_flagged: false, wash_confidence: "partial", confidence: "full" };
  assert.equal(washEvidenceFromCard(both).washConfidence, "partial");
  assert.equal(isWashCoverageAdequate(washEvidenceFromCard(both)), false);

  // An explicit nested false still refuses.
  const ringFalse = {
    wash_flagged: false,
    confidence: "full",
    circular_flow_signals: { ring_evaluated: false },
  };
  assert.equal(washEvidenceFromCard(ringFalse).ringEvaluated, false);
  assert.equal(isWashCoverageAdequate(washEvidenceFromCard(ringFalse)), false);

  // A flagged seller hard-stops regardless of which confidence key is used.
  assert.equal(washEvidenceFromCard({ wash_flagged: true, confidence: "full" }).washFlagged, true);

  console.log("wash-default.test.ts: merchant_card_v1.6 schema regression passed");
}

run()
  .then(runV16SchemaRegression)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

