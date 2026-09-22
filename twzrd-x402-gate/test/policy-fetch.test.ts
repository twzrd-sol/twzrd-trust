import assert from "node:assert/strict";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import { TwzrdWashAbortError } from "../src/paying-fetch.js";
import { createTwzrdPolicyFetch, TwzrdPolicyAbortError } from "../src/policy-fetch.js";
import { createMemorySpendLedger } from "../src/policy-runtime.js";

const WASH = "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC";
const CLEAN = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const ORIGIN = "https://origin.example/paid";
const ROUTE = "https://outbid.sh/route";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const invoice = (payTo: string) =>
  json({ accepts: [{ payTo, amount: "10000", network: "solana", asset: "USDC" }] }, 402);
const asFetch = (fn: typeof fetch) => fn as unknown as typeof fetch;
const card = (flag: boolean) =>
  asFetch(async () =>
    json({
      wash_flagged: flag,
      ...(flag === false ? { wash_confidence: "full" } : {}),
    }),
  );

async function run() {
  const signer = createLocalDecisionSigner({ keyId: "policy-fetch" });
  const seen: string[] = [];
  const wrapPay = (g: typeof fetch): typeof fetch => async (input, init) => {
    seen.push(String(input));
    const r = await g(input, init);
    return r.status === 402 ? new Response("paid", { status: 200 }) : r;
  };
  const mk = (raw: typeof fetch, wash: boolean, extra: object) =>
    createTwzrdPolicyFetch({ signer, fetch: card(wash), rawFetch: raw, wrapPay, policy: { maxAmountUsd: "1.00" }, ...extra });

  await assert.rejects(() => mk(asFetch(async () => invoice(WASH)), true, {})(ORIGIN), TwzrdWashAbortError);
  assert.equal(seen.some((u) => u.includes("/route")), false);

  seen.length = 0;
  const audits: string[] = [];
  await assert.rejects(
    () => mk(asFetch(async () => invoice(CLEAN)), false, {
      policy: { maxAmountUsd: "0.001" },
      onAudit: (d: { decision: string }) => audits.push(d.decision),
    })(ORIGIN),
    TwzrdPolicyAbortError,
  );
  assert.equal(seen.includes(ROUTE), false);
  assert.deepEqual(audits, ["block"]);

  seen.length = 0;
  const ledger = createMemorySpendLedger();
  const allow: string[] = [];
  const r = await mk(asFetch(async () => invoice(CLEAN)), false, {
    ledger,
    mandate: { mandateId: "m1", monthlyCeilingUsd: "1.00" },
    onAudit: (d: { decision: string }) => allow.push(d.decision),
  })(ORIGIN);
  assert.equal(r.status, 200);
  assert.equal(seen.includes(ROUTE), false);
  assert.deepEqual(allow, ["allow"]);
  assert.equal(ledger.spentMicro("mandate:m1", 40 * 24 * 3600 * 1000, Date.now()) > 0n, true);
  console.log("policy-fetch.test.ts: ok");
}

run().catch((e) => { console.error(e); process.exit(1); });
