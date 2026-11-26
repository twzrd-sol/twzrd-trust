// Verifies recipe 2 against a loopback MPP seller. Run: node --import ../tripwire.mjs verify.mjs
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Challenge } from "mppx";
import { Methods } from "mppx/tempo";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startStub, PAY_TO } from "../stub.mjs";
import { guardedMppx } from "./recipe.mjs";

const versions = {};
for (const p of ["twzrd-x402-gate", "mppx", "viem"]) {
  versions[p] = JSON.parse(readFileSync(join(process.cwd(), "node_modules", p, "package.json"), "utf8")).version;
}
const USDC_E_TEMPO = "0x20c000000000000000000000b9537d11c60e8b50"; // on the gate's Tempo USD list for chain 4217
const priceUsd = { overcap: "0.05", incap: "0.005" };

const mpp = (req, res, hits, url) => {
  const name = url.pathname.slice("/mpp/".length);
  const auth = req.headers["authorization"] ?? "";
  if (auth.startsWith("Payment ")) {
    hits.push("mpp-payment:" + name);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, paid: name }));
    return true;
  }
  hits.push("mpp-challenge:" + name);
  const ch = Challenge.fromMethod(Methods.charge, {
    realm: "127.0.0.1", secretKey: "loopback-only-not-a-secret",
    expires: new Date(Date.now() + 300_000).toISOString(),
    request: { amount: priceUsd[name] ?? "0.05", decimals: 6, currency: USDC_E_TEMPO, recipient: PAY_TO, chainId: 4217 },
  });
  res.writeHead(402, { "www-authenticate": Challenge.serialize(ch), "content-type": "application/json" });
  res.end(JSON.stringify({ error: "payment required" }));
  return true;
};

// Throwaway key, in memory only. Every signing method is counted.
const base = privateKeyToAccount(generatePrivateKey());
let accountSigns = 0;
const count = (fn) => async (...a) => { accountSigns++; return fn(...a); };
const account = { ...base, sign: count(base.sign), signMessage: count(base.signMessage),
  signTransaction: count(base.signTransaction), signTypedData: count(base.signTypedData) };

const stub = await startStub({ mpp, trust: "down" });
const runDir = mkdtempSync(join(process.cwd(), "run-"));
const out = { versions, stub: stub.base, cases: {} };

async function runCase(key, name, gateExtra) {
  const before = { accountSigns, hits: stub.hits.length };
  let credentialCalls = 0;
  const client = guardedMppx(account, {
    gate: { intelligenceOptions: { intelBase: stub.base }, decisionFile: join(runDir, key + ".decisions.jsonl"), ...gateExtra },
    mppx: { fetch: globalThis.fetch },
    // Instrument the seat: count every credential the guard asks mppx for. On allow, hand back a
    // dummy credential instead of mppx's, so no Tempo transaction is built or signed in this test.
    instrument: (guard) => (challenge, helpers) => guard(challenge, {
      ...helpers,
      createCredential: async () => { credentialCalls++; return "Payment " + Buffer.from('{"loopback":"dummy credential"}').toString("base64url"); },
    }),
  });
  let result;
  try {
    const r = await client.fetch(stub.base + "/mpp/" + name);
    result = { status: r.status };
  } catch (e) {
    result = { threw: e.name, code: e.code, reasonCodes: e.reasonCodes, message: String(e.message).slice(0, 200) };
  }
  out.cases[key] = { quoteUsd: priceUsd[name], result, credentialCalls, accountSigns: accountSigns - before.accountSigns, stubHits: stub.hits.slice(before.hits) };
}
await runCase("A_overcap", "overcap", {});
await runCase("B_incap_trust_down", "incap", {});
stub.state.trust = "allow";
await runCase("C_incap_trust_allow", "incap", {});
stub.state.trust = "down";
out.tripwireHits = globalThis.__tripwireHits ?? "tripwire not loaded";
out.runDir = runDir;
await stub.close();
console.log(JSON.stringify(out, null, 2));
const a = out.cases.A_overcap;
const pass = a.result.code === "PAYMENT_CONTROL_BLOCK" && (a.result.reasonCodes ?? []).includes("POLICY_MAX_AMOUNT")
  && a.credentialCalls === 0 && a.accountSigns === 0 && !a.stubHits.some((h) => h.startsWith("mpp-payment") || h.startsWith("intel:"))
  && Array.isArray(out.tripwireHits) && out.tripwireHits.length === 0;
console.log("RESULT recipe2 over-cap refused before credential/signer:", pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
