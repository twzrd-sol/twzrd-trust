/**
 * The README "Refuse before you sign without this package" snippet must refuse
 * exactly the payments createBuyerFetch refuses, for the same intel answers.
 * The code is read from the README's paste-in-preflight blocks, not copied
 * here, so an edit to the published snippet is what gets tested.
 * Run: npx tsx --test test/readme-paste-in-preflight.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { x402Client } from "@x402/fetch";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { createBuyerFetch, BuyerFetchBlockedError } from "../src/buyer-fetch.js";

type Card = Record<string, unknown>;
type Snippet = {
  beforeYouPay(input: { payTo: string; priceUsdc: number; resourceUrl: string }): Promise<Card>;
  quickOnWarn(card: Card, payTo: string, payingFetch: typeof fetch): Promise<void>;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const blocks = [...readme.matchAll(/<!-- paste-in-preflight:start -->\s*```js\n([\s\S]*?)```\s*<!-- paste-in-preflight:end -->/g)]
  .map(m => m[1]);

const dir = mkdtempSync(join(tmpdir(), "twzrd-paste-in-"));
const file = join(dir, "snippet.mjs");
writeFileSync(file, `${blocks.join("\n")}\nexport { beforeYouPay, quickOnWarn };\n`);
const snippet = (await import(pathToFileURL(file).href)) as Snippet;
rmSync(dir, { recursive: true, force: true });

const NETWORK = "eip155:8453" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0x1111111111111111111111111111111111111111";
const URL = "https://merchant.example/paid";
const AMOUNT = "1000"; // 0.001 USDC
const PRICE = 0.001;

/** A measured, full-coverage clean merchant card, as live ?full=true spells it. */
const CLEAN = { wash_flagged: false, wash_confidence: "full" };

/** One intel answer pair: the preflight and the merchant card. */
type Intel = {
  preflight?: { status?: number; body?: unknown; raw?: string } | "hang";
  merchant?: { status?: number; body?: unknown };
};

function intelResponse(intel: Intel, url: string, signal?: AbortSignal | null): Promise<Response> | undefined {
  if (url.includes("/v1/intel/preflight")) {
    const pf = intel.preflight ?? {};
    if (pf === "hang") {
      return new Promise((_, reject) => {
        // AbortSignal.timeout() is unref'd; a real socket keeps the loop alive, so the mock must too
        // (Node 20's runner otherwise cancels the test as "Promise resolution is still pending").
        const keepAlive = setTimeout(() => reject(new Error("hang mock: never aborted")), 10_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(signal.reason);
        }, { once: true });
      });
    }
    if (pf.raw !== undefined) return Promise.resolve(new Response(pf.raw, { status: pf.status ?? 200 }));
    return Promise.resolve(Response.json(pf.body ?? {}, { status: pf.status ?? 200 }));
  }
  if (url.includes("/v1/intel/merchant_card/")) {
    const mc = intel.merchant ?? {};
    return Promise.resolve(Response.json(mc.body ?? CLEAN, { status: mc.status ?? 200 }));
  }
  return undefined;
}

async function runSnippet(intel: Intel): Promise<"proceed" | "refuse"> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const response = intelResponse(intel, url, init?.signal);
    if (!response) throw new Error(`snippet called an unexpected URL: ${url}`);
    return response;
  }) as typeof fetch;
  try {
    await snippet.beforeYouPay({ payTo: SELLER, priceUsdc: PRICE, resourceUrl: URL });
    return "proceed";
  } catch {
    return "refuse";
  } finally {
    globalThis.fetch = original;
  }
}

async function runBuyerFetch(intel: Intel): Promise<"proceed" | "refuse"> {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-paste-in-buyer-"));
  let signs = 0;
  const client = new x402Client();
  client.setSpendControls(false);
  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    async createPaymentPayload(version) {
      signs++;
      return { x402Version: version, payload: { fixture: true } };
    },
  };
  client.register(NETWORK, scheme);
  const payment: PaymentRequired = {
    x402Version: 2,
    resource: { url: URL },
    accepts: [{ scheme: "exact", network: NETWORK, asset: USDC, amount: AMOUNT,
      payTo: SELLER, maxTimeoutSeconds: 60, extra: {} }],
  };
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const intelAnswer = intelResponse(intel, request.url, request.signal);
    if (intelAnswer) return intelAnswer;
    if (request.url !== URL) throw new Error(`Unexpected request: ${request.url}`);
    if (request.headers.has("payment-signature")) return Response.json({ ok: true });
    return new Response(null, { status: 402, headers: {
      "payment-required": Buffer.from(JSON.stringify(payment)).toString("base64"),
    } });
  };
  const guarded = createBuyerFetch({ client, maxPricePerCall: "0.05", allowedRecipients: [SELLER],
    decisionFile: join(dir, "decisions.jsonl"), spendLedgerFile: join(dir, "spend.jsonl"),
    intelTimeoutMs: 50, fetch: transport });
  try {
    await guarded(URL);
    assert.equal(signs, 1, "a proceeding buyer fetch signs once");
    return "proceed";
  } catch (error) {
    assert.ok(error instanceof BuyerFetchBlockedError, `refusal is a BuyerFetchBlockedError: ${error}`);
    assert.equal(signs, 0, "a refused buyer fetch never signs");
    return "refuse";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const card = (fields: Card) => ({ body: { readiness_card: fields } });
const CASES: Array<[string, Intel, "proceed" | "refuse"]> = [
  ["allow under cap", { preflight: card({ decision: "allow", trust_score: 90, recommended_cap_usdc: 1 }) }, "proceed"],
  ["allow with no cap", { preflight: card({ decision: "allow", trust_score: 90 }) }, "proceed"],
  ["allow at score floor 40", { preflight: card({ decision: "allow", trust_score: 40, recommended_cap_usdc: 1 }) }, "proceed"],
  ["warn within cap", { preflight: card({ decision: "warn", trust_score: 54.4, recommended_cap_usdc: 0.002 }) }, "proceed"],
  ["warn at exactly its cap", { preflight: card({ decision: "warn", trust_score: 54.4, recommended_cap_usdc: PRICE }) }, "proceed"],
  ["warn with can_spend false", { preflight: card({ decision: "warn", trust_score: 54.4, recommended_cap_usdc: 0.002, can_spend: false }) }, "proceed"],
  ["warn over cap", { preflight: card({ decision: "warn", trust_score: 54.4, recommended_cap_usdc: 0.0005 }) }, "refuse"],
  ["warn with no cap", { preflight: card({ decision: "warn", trust_score: 54.4 }) }, "refuse"],
  ["allow over cap", { preflight: card({ decision: "allow", trust_score: 90, recommended_cap_usdc: 0.0005 }) }, "refuse"],
  ["block", { preflight: card({ decision: "block", trust_score: 30, recommended_cap_usdc: 0 }) }, "refuse"],
  ["allow below score floor", { preflight: card({ decision: "allow", trust_score: 39.9, recommended_cap_usdc: 1 }) }, "refuse"],
  ["allow with no trust_score", { preflight: card({ decision: "allow", recommended_cap_usdc: 1 }) }, "refuse"],
  ["unknown_subject within its cap", { preflight: card({ decision: "warn", trust_score: 45, null_reason: "unknown_subject", recommended_cap_usdc: 0.1 }) }, "refuse"],
  ["explicit score null", { preflight: card({ decision: "allow", trust_score: 90, score: null, recommended_cap_usdc: 1 }) }, "refuse"],
  ["unrecognised decision", { preflight: card({ decision: "nonsense", trust_score: 99 }) }, "refuse"],
  ["no readiness_card", { preflight: { body: {} } }, "refuse"],
  ["wash_flagged true", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { body: { wash_flagged: true } } }, "refuse"],
  ["wash_flagged null", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { body: { wash_flagged: null, decision: "insufficient_evidence" } } }, "refuse"],
  ["wash_flagged absent", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { body: { decision: "no_negative_signal" } } }, "refuse"],
  ["wash false, confidence full (no ?full spelling)", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { body: { wash_flagged: false, confidence: "full" } } }, "proceed"],
  ["wash false, corpus stale only", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { body: { ...CLEAN, stale: true } } }, "proceed"],
  ["wash false, no confidence", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { body: { wash_flagged: false } } }, "refuse"],
  ["wash false, partial confidence", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { body: { wash_flagged: false, wash_confidence: "partial" } } }, "refuse"],
  ["wash false, unmeasured confidence", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { body: { wash_flagged: false, confidence: "unmeasured" } } }, "refuse"],
  ["wash false, wash_stale", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { body: { ...CLEAN, wash_stale: true } } }, "refuse"],
  ["wash false, ring not evaluated", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { body: { ...CLEAN, ring_evaluated: false } } }, "refuse"],
  ["wash false, nested ring not evaluated", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { body: { ...CLEAN, circular_flow_signals: { ring_evaluated: false } } } }, "refuse"],
  ["merchant card 404", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { status: 404, body: { detail: "not found" } } }, "refuse"],
  ["merchant card 503", { preflight: card({ decision: "allow", trust_score: 90 }), merchant: { status: 503, body: {} } }, "refuse"],
  ["preflight 503", { preflight: { status: 503, body: {} } }, "refuse"],
  ["preflight not JSON", { preflight: { raw: "<html>proxy</html>" } }, "refuse"],
  ["preflight hangs", { preflight: "hang" }, "refuse"],
];

test("the README holds both paste-in blocks", () => {
  assert.equal(blocks.length, 2);
  assert.equal(typeof snippet.beforeYouPay, "function");
  assert.equal(typeof snippet.quickOnWarn, "function");
});

for (const [name, intel, expected] of CASES) {
  test(`paste-in and createBuyerFetch agree: ${name} -> ${expected}`, async () => {
    const [pasted, packaged] = await Promise.all([runSnippet(intel), runBuyerFetch(intel)]);
    assert.equal(packaged, expected, "createBuyerFetch outcome");
    assert.equal(pasted, expected, "README snippet outcome");
  });
}

test("paste-in sends the documented request shape", async () => {
  const seen: Array<{ url: string; method: string; caller: string | null; body: string | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? "GET", caller: headers.get("x-twzrd-caller"),
      body: typeof init?.body === "string" ? init.body : null });
    return (intelResponse({ preflight: card({ decision: "allow", trust_score: 90 }) }, url) as Promise<Response>);
  }) as typeof fetch;
  try {
    await snippet.beforeYouPay({ payTo: "A b/c", priceUsdc: 0.25, resourceUrl: URL });
  } finally {
    globalThis.fetch = original;
  }
  const pf = seen.find(r => r.url.endsWith("/v1/intel/preflight"));
  const mc = seen.find(r => r.url.includes("/v1/intel/merchant_card/"));
  assert.equal(pf?.url, "https://intel.twzrd.xyz/v1/intel/preflight");
  assert.equal(pf?.method, "POST");
  assert.deepEqual(JSON.parse(pf?.body ?? "{}"), { seller_wallet: "A b/c", price_usdc: 0.25, resource_url: URL });
  assert.equal(mc?.url, "https://intel.twzrd.xyz/v1/intel/merchant_card/A%20b%2Fc?full=true");
  assert.equal(pf?.caller, "paste-in-preflight/1");
});

test("paste-in refuses an unknown price without calling intel", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  try {
    for (const priceUsdc of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      await assert.rejects(snippet.beforeYouPay({ payTo: SELLER, priceUsdc, resourceUrl: URL }), /refuse: price unknown/);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});

test("quickOnWarn buys /quick only on warn and refuses only on a paid score below 40", async () => {
  const warn = { decision: "warn", trust_score: 54.4 };
  const urls: string[] = [];
  const paying = (answer: () => Promise<Response>) =>
    (async (input: string | URL | Request) => { urls.push(String(input)); return answer(); }) as typeof fetch;

  await snippet.quickOnWarn({ decision: "allow", trust_score: 90 }, SELLER, paying(async () => Response.json({ score: 1 })));
  assert.equal(urls.length, 0, "allow never pays for /quick");

  await assert.rejects(snippet.quickOnWarn(warn, SELLER, paying(async () => Response.json({ score: 20 }))),
    /refuse: paid quick score 20/);
  assert.equal(urls.at(-1), `https://intel.twzrd.xyz/v1/intel/quick/${SELLER}`);

  // At or above the floor, or any failure of the paid call, keeps the free warn.
  await snippet.quickOnWarn(warn, SELLER, paying(async () => Response.json({ score: 40 })));
  await snippet.quickOnWarn(warn, SELLER, paying(async () => Response.json({ tier: "Gold" })));
  await snippet.quickOnWarn(warn, SELLER, paying(async () => new Response("no", { status: 500 })));
  await snippet.quickOnWarn(warn, SELLER, paying(async () => new Response("<html>", { status: 200 })));
  await snippet.quickOnWarn(warn, SELLER, paying(async () => { throw new Error("settle failed"); }));
});
