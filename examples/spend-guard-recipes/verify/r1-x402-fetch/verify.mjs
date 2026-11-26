// Verifies recipe 1 against the loopback stub. Run: node --import ../tripwire.mjs verify.mjs
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startStub, PAY_TO } from "../stub.mjs";
import { guardedPay } from "./recipe.mjs";

const versions = {};
for (const p of ["twzrd-x402-gate", "@x402/fetch", "@x402/core", "@x402/evm", "viem"]) {
  versions[p] = JSON.parse(readFileSync(join(process.cwd(), "node_modules", p, "package.json"), "utf8")).version;
}

// Throwaway key, generated in memory and never written. Every signature is counted.
const account = privateKeyToAccount(generatePrivateKey());
let signerCalls = 0;
const signer = { address: account.address, signTypedData: async (m) => { signerCalls++; return account.signTypedData(m); } };
const makeClient = () => new x402Client().register("eip155:*", new ExactEvmScheme(signer));

const stub = await startStub({ priceMicro: { overcap: 50000, incap: 5000, control: 50000 }, trust: "down" });
const runDir = mkdtempSync(join(process.cwd(), "run-"));
const testOnly = { intelBase: stub.base, decisionFile: join(runDir, "decisions.jsonl"), spendLedgerFile: join(runDir, "spend.jsonl") };
const out = { versions, stub: stub.base, cases: {} };

// Case A: quote 0.05 USDC against a 0.01 cap.
{
  const before = { signerCalls, hits: stub.hits.length };
  const pay = guardedPay(makeClient(), PAY_TO, testOnly);
  let result;
  try { const r = await pay(stub.base + "/x402/overcap"); result = { status: r.status }; }
  catch (e) { result = { threw: e.name, reason: e.reason ?? e.message }; }
  out.cases.A_overcap = { quoteUsdc: "0.05", capUsdc: "0.01", result, signerCalls: signerCalls - before.signerCalls,
    stubHits: stub.hits.slice(before.hits) };
}
// Case B: quote 0.005 USDC (under the cap), trust stub down: the guard's free preflight fails closed.
{
  const before = { signerCalls, hits: stub.hits.length };
  const pay = guardedPay(makeClient(), PAY_TO, { ...testOnly, decisionFile: join(runDir, "decisions-b.jsonl"), spendLedgerFile: join(runDir, "spend-b.jsonl") });
  let result;
  try { const r = await pay(stub.base + "/x402/incap"); result = { status: r.status }; }
  catch (e) { result = { threw: e.name, reason: e.reason ?? e.message }; }
  out.cases.B_incap_trust_down = { quoteUsdc: "0.005", result, signerCalls: signerCalls - before.signerCalls, stubHits: stub.hits.slice(before.hits) };
}
// Case C: quote 0.005 USDC, loopback trust stub answers allow: the guard lets the signer run once.
{
  stub.state.trust = "allow";
  const before = { signerCalls, hits: stub.hits.length };
  const pay = guardedPay(makeClient(), PAY_TO, { ...testOnly, decisionFile: join(runDir, "decisions-c.jsonl"), spendLedgerFile: join(runDir, "spend-c.jsonl") });
  let result;
  try { const r = await pay(stub.base + "/x402/incap"); result = { status: r.status, body: await r.json() }; }
  catch (e) { result = { threw: e.name, reason: e.reason ?? e.message }; }
  out.cases.C_incap_trust_allow = { quoteUsdc: "0.005", result, signerCalls: signerCalls - before.signerCalls, stubHits: stub.hits.slice(before.hits) };
  // 0.28.x: the paid answer carried no settlement header, so the signed hold stays counted (no release row).
  out.cases.C_incap_trust_allow.ledgerRows = readFileSync(join(runDir, "spend-c.jsonl"), "utf8").trim().split("\n")
    .map((l) => { const r = JSON.parse(l); return { type: r.type, hold_micro: r.hold_micro, signed: r.signed }; });
  stub.state.trust = "down";
}
// Control D: the same signer through plain wrapFetchWithPayment (no guard) on the 0.05 quote: it signs.
{
  const before = { signerCalls, hits: stub.hits.length };
  const pay = wrapFetchWithPayment(fetch, makeClient());
  let result;
  try { const r = await pay(stub.base + "/x402/control"); result = { status: r.status }; }
  catch (e) { result = { threw: e.name, reason: e.message }; }
  out.cases.D_control_unguarded = { quoteUsdc: "0.05", result, signerCalls: signerCalls - before.signerCalls, stubHits: stub.hits.slice(before.hits) };
}
out.tripwireHits = globalThis.__tripwireHits ?? "tripwire not loaded";
out.runDir = runDir;
await stub.close();
console.log(JSON.stringify(out, null, 2));
const a = out.cases.A_overcap;
const pass = a.result.reason === "price_cap_exceeded" && a.signerCalls === 0 && !a.stubHits.some((h) => h.startsWith("x402-payment"))
  && !a.stubHits.some((h) => h.startsWith("intel:")) && Array.isArray(out.tripwireHits) && out.tripwireHits.length === 0;
console.log("RESULT recipe1 over-cap refused before signer:", pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
