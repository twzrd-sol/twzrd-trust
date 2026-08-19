/**
 * Delivery capture unit + safeFetch integration tests (no real pay, no network).
 * Run: npx tsx test/delivery-capture.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import {
  assessSchemaMatch,
  captureDeliveryObservation,
  DELIVERY_OBSERVATION_PATH,
  extractAdvertisedOutput,
  extractSettlementTx,
} from "../src/delivery-capture.js";
import { safeFetch } from "../src/safe-fetch.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PLATFORM = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const TX = "255etmR96qCE6Z6uXKvXw2UQtQiDtGBS9WGkGbXCdAkra4eyjLqZBvCm1Z5Xq8pAeVs4t6DamFDH7hr84ZK8JQJN";

const CHALLENGE_WITH_EXAMPLE = {
  accepts: [{ network: SOL, payTo: PLATFORM, amount: "50000" }],
  extensions: {
    bazaar: {
      info: {
        output: { type: "json", example: { paid: true, score: 61.8, receipt: {} } },
      },
    },
  },
};

async function run() {
  // --- extractAdvertisedOutput -------------------------------------------
  {
    const adv = extractAdvertisedOutput(CHALLENGE_WITH_EXAMPLE);
    assert.equal(adv.jsonExpected, true);
    assert.deepEqual(adv.exampleKeys.sort(), ["paid", "receipt", "score"]);
    const none = extractAdvertisedOutput({ accepts: [] });
    assert.equal(none.jsonExpected, false);
    assert.deepEqual(none.exampleKeys, []);
    // hostile shapes never throw
    for (const bad of [null, 42, "x", { extensions: { bazaar: { info: { output: "s" } } } }]) {
      extractAdvertisedOutput(bad);
    }
  }

  // --- assessSchemaMatch --------------------------------------------------
  {
    const adv = extractAdvertisedOutput(CHALLENGE_WITH_EXAMPLE);
    // every advertised example key present -> match at example_keys
    const good = assessSchemaMatch({ paid: true, score: 1, receipt: {}, extra: 1 }, adv);
    assert.deepEqual(good, { schemaMatch: true, checkLevel: "example_keys" });
    // merchant advertised `receipt` but did not return it -> mismatch
    const missing = assessSchemaMatch({ paid: true, score: 1 }, adv);
    assert.deepEqual(missing, { schemaMatch: false, checkLevel: "example_keys" });
    // type-only advertisement
    const typeOnly = { jsonExpected: true, exampleKeys: [] };
    assert.deepEqual(assessSchemaMatch({ any: 1 }, typeOnly),
      { schemaMatch: true, checkLevel: "output_type" });
    assert.deepEqual(assessSchemaMatch("plain text", typeOnly),
      { schemaMatch: false, checkLevel: "output_type" });
    // nothing advertised -> weakest check: delivered-something
    const noAdv = { jsonExpected: false, exampleKeys: [] as string[] };
    assert.deepEqual(assessSchemaMatch("ok", noAdv),
      { schemaMatch: true, checkLevel: "body_nonempty" });
    assert.deepEqual(assessSchemaMatch("   ", noAdv),
      { schemaMatch: false, checkLevel: "body_nonempty" });
    assert.deepEqual(assessSchemaMatch(null, noAdv),
      { schemaMatch: false, checkLevel: "body_nonempty" });
  }

  // --- extractSettlementTx ------------------------------------------------
  {
    assert.equal(extractSettlementTx({ tx: TX }), TX);
    assert.equal(extractSettlementTx({ payment: { signature: TX } }), TX);
    assert.equal(extractSettlementTx({ twzrd_receipt: { preimage: { settlement_tx: TX } } }), TX);
    assert.equal(extractSettlementTx({ tx: "not-base58-0OIl" }), null);
    assert.equal(extractSettlementTx({ a: { b: { c: { tx: TX } } } }), null); // depth cap
    assert.equal(extractSettlementTx("just text"), null);
    assert.equal(extractSettlementTx(null), null);
  }

  // --- captureDeliveryObservation ----------------------------------------
  {
    // posts to the collector with caller attribution; resolves posted:true on 2xx
    const posts: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const cfg = resolveConfig({
      intelBase: "https://intel.test",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        posts.push({
          url: String(input),
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: JSON.parse(String(init?.body)),
        });
        return new Response("{}", { status: 202 });
      }) as typeof fetch,
    });
    const r = await captureDeliveryObservation(
      {
        merchantWallet: PLATFORM,
        httpStatus: 200,
        resourceBody: { paid: true, score: 1, receipt: {}, tx: TX },
        challengeBody: CHALLENGE_WITH_EXAMPLE,
        latencyMs: 500,
        network: SOL,
      },
      cfg,
    );
    assert.equal(r.posted, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `https://intel.test${DELIVERY_OBSERVATION_PATH}`);
    assert.match(posts[0].headers["X-Twzrd-Caller"], /^twzrd-x402-gate\//);
    const sent = posts[0].body as Record<string, unknown>;
    assert.equal(sent.merchant_wallet, PLATFORM);
    assert.equal(sent.settlement_tx, TX);
    assert.equal(sent.schema_match, true);
    assert.equal(sent.check_level, "example_keys");
    assert.equal(sent.source, "gate_post_settle");
  }
  {
    // collector down -> posted:false, never throws
    const cfg = resolveConfig({
      intelBase: "https://intel.test",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const r = await captureDeliveryObservation(
      { merchantWallet: PLATFORM, httpStatus: 200, resourceBody: "x", challengeBody: {} },
      cfg,
    );
    assert.equal(r.posted, false);
    assert.equal(r.observation.check_level, "body_nonempty");
  }
  {
    // kill switches: env and per-call flag -> no fetch at all
    let calls = 0;
    const cfg = resolveConfig({
      intelBase: "https://intel.test",
      fetch: (async () => {
        calls += 1;
        return new Response("{}", { status: 202 });
      }) as unknown as typeof fetch,
    });
    const argsBase = {
      merchantWallet: PLATFORM,
      httpStatus: 200,
      resourceBody: "x",
      challengeBody: {},
    };
    const off = await captureDeliveryObservation({ ...argsBase, enabled: false }, cfg);
    assert.equal(off.posted, false);
    process.env.TWZRD_DELIVERY_CAPTURE = "0";
    try {
      const envOff = await captureDeliveryObservation(argsBase, cfg);
      assert.equal(envOff.posted, false);
    } finally {
      delete process.env.TWZRD_DELIVERY_CAPTURE;
    }
    assert.equal(calls, 0);
  }

  // --- safeFetch integration: paid path captures + posts ------------------
  {
    const posts: string[] = [];
    const events: string[] = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.includes(DELIVERY_OBSERVATION_PATH)) {
        posts.push(String(init?.body));
        return new Response("{}", { status: 202 });
      }
      if (u.includes("/preflight")) {
        return new Response(
          JSON.stringify({
            readiness_card: {
              decision: "allow",
              can_spend: true,
              trust_score: 80,
              seller_wallet: PLATFORM,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(CHALLENGE_WITH_EXAMPLE), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const r = await safeFetch({
      url: "https://merchant.example/paid",
      intelBase: "https://intel.test",
      refuseWashFlagged: false,
      fetch: mockFetch,
      runPayer: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ paid: true, score: 61.8, receipt: {}, tx: TX }),
        stderr: "",
      }),
      onEvent: (e) => events.push(e),
    });
    assert.equal(r.phase, "paid");
    assert.ok(r.deliveryCapture, "paid result carries deliveryCapture");
    assert.equal(r.deliveryCapture?.posted, true);
    assert.equal(r.deliveryCapture?.observation.schema_match, true);
    assert.equal(r.deliveryCapture?.observation.check_level, "example_keys");
    assert.equal(r.deliveryCapture?.observation.settlement_tx, TX);
    assert.equal(r.deliveryCapture?.observation.merchant_wallet, PLATFORM);
    assert.ok(events.includes("delivery_observation"));
    assert.equal(posts.length, 1, "exactly one collector POST");
  }
  {
    // opts.deliveryCapture=false -> observation built, nothing posted
    const posts: string[] = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.includes(DELIVERY_OBSERVATION_PATH)) {
        posts.push(String(init?.body));
        return new Response("{}", { status: 202 });
      }
      if (u.includes("/preflight")) {
        return new Response(
          JSON.stringify({
            readiness_card: {
              decision: "allow",
              can_spend: true,
              trust_score: 80,
              seller_wallet: PLATFORM,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(CHALLENGE_WITH_EXAMPLE), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const r = await safeFetch({
      url: "https://merchant.example/paid",
      intelBase: "https://intel.test",
      refuseWashFlagged: false,
      deliveryCapture: false,
      fetch: mockFetch,
      runPayer: async () => ({ exitCode: 0, stdout: "{\"ok\":true}", stderr: "" }),
    });
    assert.equal(r.phase, "paid");
    assert.equal(r.deliveryCapture?.posted, false);
    assert.equal(posts.length, 0, "no collector POST when disabled");
  }
  {
    // blocked path never captures (nothing was paid, nothing was delivered)
    const posts: string[] = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.includes(DELIVERY_OBSERVATION_PATH)) {
        posts.push(String(init?.body));
        return new Response("{}", { status: 202 });
      }
      if (u.includes("/preflight")) {
        return new Response(
          JSON.stringify({
            readiness_card: {
              decision: "block",
              can_spend: false,
              trust_score: 5,
              seller_wallet: PLATFORM,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(CHALLENGE_WITH_EXAMPLE), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const r = await safeFetch({
      url: "https://merchant.example/paid",
      intelBase: "https://intel.test",
      refuseWashFlagged: false,
      fetch: mockFetch,
      runPayer: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    });
    assert.equal(r.phase, "blocked");
    assert.equal(r.deliveryCapture, undefined);
    assert.equal(posts.length, 0);
  }

  console.log("delivery-capture tests passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
