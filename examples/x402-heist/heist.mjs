import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createBuyerFetch, sharedFileDecisionLedger } from "twzrd-x402-gate";

const HONEST = "0x1111111111111111111111111111111111111111";
const THIEF = "0x7777777777777777777777777777777777777777";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NETWORK = "eip155:8453";
const CAP = 10_000n;
const BUDGET = 30_000n;

function offer(changes = {}) {
  return { scheme: "exact", network: NETWORK, asset: USDC, amount: "5000",
    payTo: HONEST, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" }, ...changes };
}

function document(url, offers = [offer()]) {
  return { x402Version: 2, resource: { url, description: "Loopback heist", mimeType: "application/json" },
    accepts: offers };
}

const single = changes => url => ({ header: document(url, [offer(changes)]) });
const drip = single({ amount: "9000" });

// Add a trick as one entry. Header and body are x402 documents, not encoded strings.
const tricks = [
  { id: "honest", title: "Honest seller", control: true, challenge: single({}) },
  { id: "lowercase-ok", title: "Lowercase addresses", control: true,
    challenge: single({ payTo: HONEST.toLowerCase(), asset: USDC.toLowerCase() }) },
  { id: "gouge", title: "Five times the price cap", challenge: single({ amount: "50000" }) },
  { id: "swap-payto", title: "Thief recipient", challenge: single({ payTo: THIEF }) },
  { id: "fake-asset", title: "Fake USD Coin", challenge: single({
    asset: "0x9999999999999999999999999999999999999999", amount: "999999999999999999999999999" }) },
  { id: "chain-hop", title: "Ethereum mainnet", challenge: single({ network: "eip155:1" }) },
  { id: "testnet-usdc", title: "Mainnet asset on testnet", challenge: single({ network: "eip155:84532" }) },
  { id: "decoy-pair", title: "Honest offer then thief", challenge: url => ({
    header: document(url, [offer(), offer({ payTo: THIEF, amount: "50000" })]) }) },
  { id: "decoy-reverse", title: "Thief offer then honest", challenge: url => ({
    header: document(url, [offer({ payTo: THIEF, amount: "50000" }), offer()]) }) },
  { id: "split-brain", title: "Header and body disagree", challenge: url => ({
    header: document(url, [offer({ payTo: THIEF, amount: "50000" })]), body: document(url) }) },
  ...["5e4", "0xC350", "050000", "5000.9", "-5000", (2n ** 256n).toString()].map((amount, i) => ({
    id: ["amount-exponent", "amount-hex", "amount-leading-zero", "amount-fraction", "amount-negative", "amount-overflow"][i],
    title: i === 5 ? "Amount 2^256" : `Amount ${amount}`, challenge: single({ amount }) })),
  { id: "space-payto", title: "Recipient with leading space", challenge: single({ payTo: " " + THIEF }) },
  { id: "redirect", title: "Redirect to another seller", redirect: true, challenge: single({}) },
  { id: "drip", title: "Six small purchases", calls: 6, challenge: drip },
  { id: "drip-paths", title: "Six different paths", calls: 6, paths: true, challenge: drip },
  { id: "drip-agents", title: "Six buyer instances, one ledger", calls: 6, freshBuyer: true, challenge: drip },
];

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function listen(handler) {
  const errors = [];
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch(error => {
      errors.push(error);
      json(res, 500, { error: "fixture failed" });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { base: `http://127.0.0.1:${server.address().port}`, errors,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }) };
}

function seller(trick, state) {
  return async (req, res) => {
    const payment = req.headers["payment-signature"] ?? req.headers["x-payment"];
    if (payment) {
      const decoded = JSON.parse(Buffer.from(payment, "base64").toString("utf8"));
      const { to, value } = decoded.payload.authorization;
      // Count authorizations received, never a claimed HTTP settlement or balance.
      state.payments.push({ to, value, network: decoded.accepted?.network, asset: decoded.accepted?.asset });
      return json(res, 200, { ok: true });
    }
    const url = `http://${req.headers.host}${req.url}`;
    const { header, body = header } = await trick.challenge(url);
    json(res, 402, body, { "payment-required": Buffer.from(JSON.stringify(header)).toString("base64") });
  };
}

function usdc(micro) {
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`;
}

async function play(trick, intelBase) {
  const dir = await mkdtemp(join(tmpdir(), "x402-heist-"));
  const servers = [];
  const decisionFile = join(dir, "decisions.jsonl");
  const spendLedgerFile = join(dir, "spend.jsonl");
  const state = { signatures: 0, payments: [] };
  const reasons = new Set();
  let successes = 0;
  try {
    const shop = await listen(seller(trick, state));
    servers.push(shop);
    let target = shop.base;
    if (trick.redirect) {
      const redirector = await listen((_req, res) => {
        res.writeHead(302, { location: shop.base + "/charge" });
        res.end();
      });
      servers.push(redirector);
      target = redirector.base;
    }
    // No key file, RPC, facilitator or funded wallet. The key lives only in memory.
    const account = privateKeyToAccount(generatePrivateKey());
    const signer = { address: account.address, signTypedData: async data => {
      state.signatures++;
      return account.signTypedData(data);
    } };
    const makeBuyer = () => createBuyerFetch({
      client: new x402Client().register("eip155:*", new ExactEvmScheme(signer)),
      maxPricePerCall: "0.01", allowedRecipients: [HONEST], hourlyBudgetCap: "0.03",
      intelBase, decisionFile, spendLedgerFile,
    });
    let pay = makeBuyer();
    for (let call = 0; call < (trick.calls ?? 1); call++) {
      if (call && trick.freshBuyer) pay = makeBuyer();
      try {
        const response = await pay(target + (trick.paths ? `/loot/${call}` : "/loot"), {
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status !== 200 || (await response.json()).ok !== true) {
          throw new Error("fixture did not return a paid response");
        }
        successes++;
      } catch (error) {
        if (typeof error.reason !== "string") throw error;
        reasons.add(error.reason);
      }
      const total = state.payments.reduce((sum, p) => sum + BigInt(p.value), 0n);
      if (total > BUDGET || state.payments.some(p =>
        p.to.toLowerCase() !== HONEST.toLowerCase() || BigInt(p.value) > CAP || BigInt(p.value) < 0n ||
        p.network !== NETWORK || p.asset?.toLowerCase() !== USDC.toLowerCase())) {
        // Stop before running further tricks. A failing local run must never be committed.
        throw new Error(`ROBBED: ${trick.id}; signatures=${state.signatures}; payments=${JSON.stringify(state.payments)}`);
      }
    }
    if (servers.some(s => s.errors.length)) throw new AggregateError(servers.flatMap(s => s.errors));
    const total = state.payments.reduce((sum, p) => sum + BigInt(p.value), 0n);
    const verdict = state.signatures === 0 && state.payments.length === 0 ? "DEFENDED" : "CAPPED";
    const expectedPayments = trick.calls ? 3 : trick.control || trick.id === "decoy-pair" ? 1 : 0;
    const expectedTotal = trick.calls ? 27_000n : expectedPayments ? 5_000n : 0n;
    return { id: trick.id, title: trick.title, verdict, signatures: state.signatures,
      payments: state.payments, totalUsdc: usdc(total), reason: [...reasons].join(",") || "paid",
      matchesExpected: state.payments.length === expectedPayments && total === expectedTotal &&
        state.signatures === expectedPayments && successes === expectedPayments };
  } finally {
    try {
      await Promise.all(servers.map(s => s.close()));
      await sharedFileDecisionLedger(decisionFile).flush();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function main() {
  if (!Array.isArray(globalThis.__tripwireHits)) throw new Error("Run with --import ./tripwire.mjs");
  const trust = await listen(async (req, res) => {
    if (req.method === "POST" && req.url.startsWith("/v1/intel/preflight")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const posted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return json(res, 200, { readiness_card: { decision: "allow", trust_score: 90, can_spend: true,
        seller_wallet: posted.seller_wallet, maximum_recommended_spend_usdc: 5 } });
    }
    if (req.method === "GET" && req.url.startsWith("/v1/intel/merchant_card/")) {
      return json(res, 200, { wash_flagged: false, wash_confidence: "full" });
    }
    json(res, 404, { error: "unknown trust path" });
  });
  const rows = [];
  try {
    for (const trick of tricks) rows.push(await play(trick, trust.base));
    if (trust.errors.length) throw new AggregateError(trust.errors);
  } finally {
    await trust.close();
  }
  const report = { node: process.version, gate: "0.28.1", tripwireHits: globalThis.__tripwireHits.length,
    rows, differences: rows.filter(row => !row.matchesExpected).map(row => row.id) };
  if (process.argv.includes("--json")) console.log(JSON.stringify(report));
  else {
    console.log(`x402-heist | Node ${report.node} | twzrd-x402-gate ${report.gate}`);
    console.log("trick                verdict   signatures  payments  USDC       recipient  reason");
    for (const row of rows) {
      const who = [...new Set(row.payments.map(p => p.to === HONEST ? "HONEST" : p.to))].join(",") || "-";
      console.log(`${row.id.padEnd(20)} ${row.verdict.padEnd(9)} ${String(row.signatures).padEnd(11)} ` +
        `${String(row.payments.length).padEnd(9)} ${row.totalUsdc.padEnd(10)} ${who.padEnd(10)} ${row.reason}`);
    }
    console.log(`HONEST = ${HONEST}`);
    console.log(`Tripwire hits: ${report.tripwireHits}`);
    console.log(`Expectation differences: ${report.differences.join(", ") || "none"}`);
    console.log("ROBBED: 0");
  }
  const controlsPaid = rows.filter(row => tricks.find(t => t.id === row.id).control)
    .every(row => row.payments.length === 1 && row.totalUsdc === "0.005000");
  // Drift fails the example too; do not silently turn unexpected refusals into passing controls.
  process.exitCode = controlsPaid && report.tripwireHits === 0 && report.differences.length === 0 ? 0 : 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
