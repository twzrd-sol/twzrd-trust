import assert from "node:assert/strict";
import test from "node:test";
import { createTwzrdBeforePaymentHook, createTwzrdPayingFetch } from "../src/index.js";
import { createTwzrdCloudflareBaseApproval } from "../src/cloudflare-base.js";
import { isTrueFlag } from "../src/config.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const down = (async () => json({}, 503)) as unknown as typeof fetch;
const CLEAN = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const WASH = "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC";
const BWASH = "0x1111111111111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("isTrueFlag: only recognised true spellings are on", () => {
  for (const v of [true, 1, "true", "TRUE", "yes", "on", "1"]) assert.equal(isTrueFlag(v), true);
  for (const v of [false, 0, "false", "0", "no", "tru", "", undefined, null]) assert.equal(isTrueFlag(v), false);
});

test("failOpen given as a string never opens on an outage", async () => {
  for (const fo of ["false", "0", "no"]) {
    const hook = createTwzrdBeforePaymentHook({ fetch: down, failOpen: fo as unknown as boolean });
    const r = await hook({ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: USDC, payTo: CLEAN, amount: "1000" } as never);
    assert.ok(r && (r as { abort?: boolean }).abort);
  }
});

test("Base Worker honours string refuseUnevaluated and has a deadline", async () => {
  const uneval = { decision: "warn", can_spend: true, trust_score: 45, score: null, null_reason: "unknown_subject", recommended_cap_usdc: 1 };
  const ok = (async () => json({ readiness_card: uneval })) as unknown as typeof fetch;
  const accepts = [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCd6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xfB9819456bd9248A9D3c9E12F4cb7bBda5fc2578", amount: "1000" }];
  assert.equal(await createTwzrdCloudflareBaseApproval({ fetch: ok, refuseUnevaluated: "true" as unknown as boolean })({ resource: "https://s.test", accepts }), false);
  const hang = ((_u: unknown, init?: RequestInit) => new Promise(() => void init)) as unknown as typeof fetch;
  const t0 = Date.now();
  assert.equal(await createTwzrdCloudflareBaseApproval({ fetch: hang, intelTimeoutMs: 100 })({ resource: "https://s.test", accepts }), false);
  assert.ok(Date.now() - t0 < 1500);
});

test("paying fetch scores every offer and refuses an entry with no recipient", async () => {
  const card = (async (u: unknown) => json(String(u).includes(WASH) || String(u).includes(BWASH) ? { wash_flagged: true } : { wash_flagged: false, wash_confidence: "full" })) as unknown as typeof fetch;
  const sol = (payTo: string) => ({ scheme: "exact", network: "solana", asset: "USDC", payTo, amount: "1000" });
  const base = { scheme: "exact", network: "eip155:8453", asset: "USDC", payTo: BWASH, amount: "1000" };
  for (const accepts of [[base, sol(CLEAN)], [sol(CLEAN), base], [sol(""), base]]) {
    const raw = (async () => json({ accepts }, 402)) as unknown as typeof fetch;
    const f = createTwzrdPayingFetch({ fetch: card, rawFetch: raw, deliveryCapture: false, wrapPay: (g) => g });
    await assert.rejects(() => f("https://o.test/paid"));
  }
});
