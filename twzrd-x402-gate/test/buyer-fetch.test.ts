import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { x402Client } from "@x402/fetch";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { createBuyerFetch, BuyerFetchBlockedError } from "../src/buyer-fetch.js";
import type { FulfillmentRecord } from "../src/fulfillment-record.js";
import { createFileSpendLedger, __resetSharedFileSpendLedgers } from "../src/spend-ledger-file.js";

const NETWORK = "eip155:8453" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const URL = "https://merchant.example/paid?secret=must-not-be-logged";

function setup(options: {
  amount?: string;
  recipient?: string;
  preflight?: "allow" | "warn" | "block" | "down" | "invalid" | "hang";
  recommendedCap?: number;
  hourlyBudgetCap?: string;
  dir?: string;
  signerFails?: boolean;
  coreDefaults?: boolean;
} = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "twzrd-buyer-test-"));
  const state = { signs: 0, paid: 0, preflights: 0, network: [] as string[] };
  const client = new x402Client();
  if (!options.coreDefaults) client.setSpendControls(false);
  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    async createPaymentPayload(version, requirements) {
      state.signs++;
      if (options.signerFails) throw new Error("signer unavailable");
      return { x402Version: version, payload: { fixture: true } };
    },
  };
  client.register(NETWORK, scheme);
  const payment: PaymentRequired = {
    x402Version: 2,
    resource: { url: URL },
    accepts: [{ scheme: "exact", network: NETWORK, asset: USDC,
      amount: options.amount ?? "1000", payTo: options.recipient ?? SELLER,
      maxTimeoutSeconds: 60, extra: {} }],
  };
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    state.network.push(request.url);
    if (request.url.includes("/v1/intel/preflight")) {
      state.preflights++;
      if (options.preflight === "down") return new Response("down", { status: 503 });
      if (options.preflight === "hang") return new Promise<Response>(() => {});
      const card = options.preflight === "invalid" ? { decision: "nonsense", trust_score: 99 } : {
        decision: options.preflight ?? "allow", trust_score: 90, seller_wallet: SELLER,
        recommended_cap_usdc: options.recommendedCap ?? 1,
      };
      return Response.json({ readiness_card: card });
    }
    if (request.url.includes("/v1/intel/merchant_card/")) return Response.json({ wash_flagged: false });
    if (request.url !== URL) throw new Error(`Unexpected request: ${request.url}`);
    if (request.headers.has("payment-signature")) {
      state.paid++;
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 402, headers: {
      "payment-required": Buffer.from(JSON.stringify(payment)).toString("base64"),
    } });
  };
  const decisionFile = join(dir, "decisions.jsonl");
  const spendLedgerFile = join(dir, "spend.jsonl");
  const config = { client, maxPricePerCall: "0.05", allowedRecipients: [SELLER],
    hourlyBudgetCap: options.hourlyBudgetCap, decisionFile, spendLedgerFile,
    intelTimeoutMs: 20, fetch: transport };
  const run = () => createBuyerFetch(config);
  const rows = () => readFileSync(decisionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { dir, state, client, payment, transport, decisionFile, spendLedgerFile, config, run, rows };
}

test("cap refuses a real paying fetch before preflight or signing and persists the reason", async () => {
  const h = setup({ amount: "50001" });
  await assert.rejects(h.run()(URL), (error: unknown) => {
    assert.ok(error instanceof BuyerFetchBlockedError);
    assert.equal(error.reason, "price_cap_exceeded");
    return true;
  });
  assert.equal(h.state.signs, 0);
  assert.equal(h.state.paid, 0);
  assert.equal(h.state.preflights, 0);
  assert.deepEqual(h.rows()[0].reason_codes, ["price_cap_exceeded"]);
  assert.equal(h.rows()[0].input.resource_origin, "https://merchant.example");
  assert.ok(!readFileSync(h.decisionFile, "utf8").includes("secret"));
});

test("a $1,000 challenge under a $1,000 cap signs unless expectedAmount binds the quote", async () => {
  const thousand = "1000000000";
  // Without an expected amount the cap is the only amount check, and $1,000 passes it.
  const open = setup({ amount: thousand, recommendedCap: 1000 });
  open.config.maxPricePerCall = "1000";
  assert.equal((await open.run()(URL)).status, 200);
  assert.equal(open.state.signs, 1);

  const bound = setup({ amount: thousand, recommendedCap: 1000 });
  bound.config.maxPricePerCall = "1000";
  await assert.rejects(createBuyerFetch({ ...bound.config, expectedAmount: "0.05" })(URL), (error: unknown) => {
    assert.ok(error instanceof BuyerFetchBlockedError);
    assert.equal(error.reason, "expected_amount_mismatch");
    return true;
  });
  assert.equal(bound.state.signs, 0);
  assert.equal(bound.state.paid, 0);
  assert.equal(bound.state.preflights, 0);
  assert.equal(bound.rows()[0].outcome, "block");
  assert.deepEqual(bound.rows()[0].reason_codes, ["expected_amount_mismatch"]);
  assert.equal(bound.rows()[0].input.amount_micro, thousand);
});

test("expectedAmount is exact: a lower challenge refuses and the quoted amount signs", async () => {
  const lower = setup({ amount: "40000" });
  await assert.rejects(createBuyerFetch({ ...lower.config, expectedAmount: "0.05" })(URL), /expected_amount_mismatch/);
  assert.equal(lower.state.signs, 0);

  const exact = setup({ amount: "50000" });
  assert.equal((await createBuyerFetch({ ...exact.config, expectedAmount: "0.050" })(URL)).status, 200);
  assert.equal(exact.state.signs, 1);
  assert.equal(exact.rows()[0].outcome, "allow");

  // The cap still applies on its own and keeps its own reason.
  const over = setup({ amount: "50001" });
  await assert.rejects(createBuyerFetch({ ...over.config, expectedAmount: "0.05" })(URL), /price_cap_exceeded/);
  assert.equal(over.state.signs, 0);
});

test("a per-payment expectedAmount function binds each quote and fails closed without one", async () => {
  const seen: unknown[] = [];
  const quoted = setup();
  const guarded = createBuyerFetch({ ...quoted.config, expectedAmount: payment => {
    seen.push(payment);
    return payment.resource === URL ? "0.001" : undefined;
  } });
  assert.equal((await guarded(URL)).status, 200);
  assert.equal(quoted.state.signs, 1);
  // The function never sees the challenged amount, so it cannot echo it back.
  assert.deepEqual(seen, [{ resource: URL, payTo: SELLER, network: NETWORK }]);

  for (const expectedAmount of [
    () => undefined, async () => { throw new Error("quote store down"); }, () => "1e3",
  ]) {
    const h = setup();
    await assert.rejects(createBuyerFetch({ ...h.config, expectedAmount })(URL), (error: unknown) => {
      assert.ok(error instanceof BuyerFetchBlockedError);
      assert.equal(error.reason, "expected_amount_unavailable");
      return true;
    });
    assert.equal(h.state.signs, 0);
    assert.equal(h.state.preflights, 0);
    assert.deepEqual(h.rows()[0].reason_codes, ["expected_amount_unavailable"]);
  }

  const mismatch = setup();
  await assert.rejects(createBuyerFetch({ ...mismatch.config, expectedAmount: async () => "0.002" })(URL),
    /expected_amount_mismatch/);
  assert.equal(mismatch.state.signs, 0);
});

test("expectedAmount is validated at install and cannot be changed afterwards", async () => {
  const h = setup();
  assert.throws(() => createBuyerFetch({ ...h.config, expectedAmount: "0.06" }), /must not exceed maxPricePerCall/);
  assert.throws(() => createBuyerFetch({ ...h.config, expectedAmount: 0.001 as never }), TypeError);
  assert.throws(() => createBuyerFetch({ ...h.config, expectedAmount: "1e-3" }), /bad decimal amount/);

  const config = { ...h.config, expectedAmount: "0.002" };
  const guarded = createBuyerFetch(config);
  config.expectedAmount = "0.001";
  await assert.rejects(guarded(URL), /expected_amount_mismatch/);
  assert.equal(h.state.signs, 0);
});

test("unlisted and missing recipients never sign; an empty allowlist denies all", async () => {
  for (const recipient of [OTHER, ""]) {
    const h = setup({ recipient });
    await assert.rejects(h.run()(URL), /recipient_missing|unauthorized_recipient/);
    assert.equal(h.state.signs, 0);
    assert.equal(h.state.preflights, 0);
    assert.equal(h.rows()[0].outcome, "block");
  }
  const h = setup();
  h.config.allowedRecipients = [];
  await assert.rejects(h.run()(URL), /unauthorized_recipient/);
  assert.equal(h.state.signs, 0);
});

test("preflight block, outage, timeout and invalid decision all refuse before sign", async () => {
  for (const preflight of ["block", "down", "hang", "invalid"] as const) {
    const h = setup({ preflight });
    await assert.rejects(h.run()(URL), BuyerFetchBlockedError);
    assert.equal(h.state.signs, 0, preflight);
    assert.equal(h.state.paid, 0, preflight);
    assert.equal(h.rows().at(-1).outcome, "block", preflight);
  }
});

test("legacy fail-open and disable environment switches cannot bypass the front door", async () => {
  const names = ["TWZRD_FAIL_OPEN", "TWZRD_AUTO_GATE", "TWZRD_GATE_ENABLED", "TWZRD_BLOCK_DECISIONS"];
  const old = names.map(name => process.env[name]);
  Object.assign(process.env, { TWZRD_FAIL_OPEN: "true", TWZRD_AUTO_GATE: "0",
    TWZRD_GATE_ENABLED: "false", TWZRD_BLOCK_DECISIONS: "allow" });
  try {
    for (const preflight of ["down", "block"] as const) {
      const h = setup({ preflight });
      await assert.rejects(h.run()(URL), BuyerFetchBlockedError);
      assert.equal(h.state.signs, 0);
    }
  } finally {
    names.forEach((name, i) => { if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i]; });
  }
});

test("allow and warn reach the paying call, write local ledgers, and never buy optional scores", async () => {
  for (const preflight of ["allow", "warn"] as const) {
    const h = setup({ preflight });
    assert.equal((await h.run()(URL)).status, 200);
    assert.equal(h.state.signs, 1);
    assert.equal(h.state.paid, 1);
    assert.equal(h.rows()[0].outcome, preflight);
    // This row records the decision BEFORE the signer, not a settlement claim.
    assert.equal(h.rows()[0].signer_invocations, 0);
    assert.equal(h.rows()[0].settlement, undefined);
    assert.equal(createFileSpendLedger(h.spendLedgerFile).spentMicro("buyer-fetch:default", 3_600_000, Date.now()), 1000n);
    assert.ok(h.state.network.every(url => url === URL || /\/v1\/intel\/(preflight|merchant_card\/)/.test(url)));
  }
});

test("shared durable hourly cap reserves across concurrent wrappers and survives ledger replay", async () => {
  const first = setup({ amount: "30000", hourlyBudgetCap: "0.05" });
  const second = setup({ amount: "30000", hourlyBudgetCap: "0.05", dir: first.dir });
  const results = await Promise.allSettled([first.run()(URL), second.run()(URL)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(first.state.signs + second.state.signs, 1);
  __resetSharedFileSpendLedgers();
  const third = setup({ amount: "30000", hourlyBudgetCap: "0.05", dir: first.dir });
  await assert.rejects(third.run()(URL), /hourly_budget_exceeded/);
  assert.equal(third.state.signs, 0);
  assert.ok(first.rows().some(row => row.reason_codes.includes("hourly_budget_exceeded")));
});

test("signer failure consumes the reserved budget conservatively", async () => {
  const h = setup({ amount: "30000", hourlyBudgetCap: "0.05", signerFails: true });
  const guarded = h.run();
  await assert.rejects(guarded(URL), /signer unavailable/);
  await assert.rejects(guarded(URL), /hourly_budget_exceeded/);
  assert.equal(h.state.signs, 1);
  assert.equal(h.state.paid, 0);
});

test("local decision and spend write failures stop the signer", async () => {
  const badDecision = setup();
  mkdirSync(badDecision.decisionFile);
  await assert.rejects(badDecision.run()(URL), /decision_log_unavailable/);
  assert.equal(badDecision.state.signs, 0);
  const badSpend = setup();
  const guarded = badSpend.run();
  mkdirSync(badSpend.spendLedgerFile);
  await assert.rejects(guarded(URL), /spend_ledger_unavailable/);
  assert.equal(badSpend.state.signs, 0);
  assert.deepEqual(badSpend.rows().at(-1).reason_codes, ["spend_ledger_unavailable"]);
});

test("a pre-signed payment cannot bypass the wrapper on the first HTTP request", async () => {
  const h = setup();
  const guarded = h.run();
  for (const name of ["payment-signature", "x-payment"]) {
    await assert.rejects(guarded(URL, { headers: { [name]: "already-signed" } }), /presigned_payment_not_allowed/);
  }
  assert.equal(h.state.network.length, 0);
  assert.equal(h.state.signs, 0);
});

test("client-level refusals before the gate are logged without invoking the signer", async () => {
  const h = setup({ amount: "2000000", coreDefaults: true });
  h.config.maxPricePerCall = "3";
  await assert.rejects(h.run()(URL), /core_spend_controls/);
  assert.equal(h.state.signs, 0);
  assert.deepEqual(h.rows()[0].reason_codes, ["core_spend_controls"]);
});

test("non-USDC, malformed, conflicting and unscored requirements fail closed", async () => {
  for (const change of [
    { asset: "0x0000000000000000000000000000000000000000" },
    { amount: "-1" }, { amount: "1e3" }, { maxAmountRequired: "2000" },
    { network: "eip155:42161" },
  ]) {
    const h = setup();
    Object.assign(h.payment.accepts[0], change);
    if (change.network) h.client.register(change.network as `${string}:${string}`, {
      scheme: "exact", async createPaymentPayload() { h.state.signs++; throw new Error("must not sign"); },
    });
    await assert.rejects(h.run()(URL));
    assert.equal(h.state.signs, 0);
    assert.equal(h.rows().at(-1).outcome, "block");
  }
});

test("ordinary responses pass through without preflight or a signing decision", async () => {
  const h = setup();
  h.config.fetch = async () => new Response("free");
  assert.equal(await (await h.run()(URL)).text(), "free");
  assert.equal(h.state.signs, 0);
  assert.equal(h.state.preflights, 0);
});

test("the returned fetch retains request method/body and refuses before sign if cancelled", async () => {
  const h = setup();
  const seen: Array<{ method: string; body: string; redirect: string }> = [];
  h.config.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === URL) seen.push({ method: request.method, body: await request.clone().text(), redirect: request.redirect });
    return h.transport(request);
  };
  assert.equal((await h.run()(new Request(URL, { method: "POST", body: '{"task":"example"}' }))).status, 200);
  assert.deepEqual(seen, Array(2).fill({ method: "POST", body: '{"task":"example"}', redirect: "error" }));
  const abort = setup();
  const controller = new AbortController();
  abort.config.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.includes("/preflight")) controller.abort();
    return abort.transport(request);
  };
  await assert.rejects(abort.run()(URL, { signal: controller.signal }), /request_aborted/);
  assert.equal(abort.state.signs, 0);
});

test("caller mutation cannot change the installed cap, allowlist or client", async () => {
  const h = setup({ recipient: OTHER });
  const guarded = h.run();
  h.config.allowedRecipients.push(OTHER);
  h.config.maxPricePerCall = "100";
  h.config.client = new x402Client();
  await assert.rejects(guarded(URL), /unauthorized_recipient/);
  assert.equal(h.state.signs, 0);
});

test("Solana mainnet USDC uses the same pre-sign policy and preserves recipient case", async () => {
  const seller = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
  const network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
  for (const allowed of [seller, seller.toLowerCase()]) {
    const h = setup();
    Object.assign(h.payment.accepts[0], { network, payTo: seller, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" });
    h.client.register(network, { scheme: "exact", async createPaymentPayload(version) {
      h.state.signs++;
      return { x402Version: version, payload: { fixture: true } };
    } });
    h.config.allowedRecipients = [allowed];
    if (allowed === seller) {
      assert.equal((await h.run()(URL)).status, 200);
      assert.equal(h.state.signs, 1);
    } else {
      await assert.rejects(h.run()(URL), /unauthorized_recipient/);
      assert.equal(h.state.signs, 0);
    }
  }
});

test("onFulfillment keeps one local row for an approved paid call and none for a refusal", async () => {
  const tx = "0x" + "ab".repeat(32);
  const settle = Buffer.from(JSON.stringify({ success: true, transaction: tx, network: NETWORK })).toString("base64");
  const withSettle = (inner: typeof fetch): typeof fetch => async (input, init) => {
    const response = await inner(input, init);
    if (!new Request(input, init).headers.has("payment-signature")) return response;
    return new Response(JSON.stringify({ model: "m-1" }), {
      status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settle },
    });
  };
  const nextRecord = (records: FulfillmentRecord[]) => new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => { if (records.length) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 5);
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error("no fulfillment record within 2s")); }, 2000);
  });

  const h = setup();
  const records: FulfillmentRecord[] = [];
  const guarded = createBuyerFetch({ ...h.config, fetch: withSettle(h.transport), onFulfillment: r => records.push(r) });
  assert.equal((await guarded(URL)).status, 200);
  await nextRecord(records);
  assert.equal(records.length, 1, "the free preflight is not a paid call");
  assert.equal(records[0].paid_to, SELLER);
  assert.equal(records[0].tx, tx);
  assert.equal(records[0].served_by, "m-1");
  assert.equal(records[0].resource_origin, "https://merchant.example");
  assert.equal(JSON.stringify(records[0]).includes("must-not-be-logged"), false);
  assert.equal(h.state.signs, 1);

  const over = setup({ amount: "50001" });
  const none: FulfillmentRecord[] = [];
  await assert.rejects(
    createBuyerFetch({ ...over.config, fetch: withSettle(over.transport), onFulfillment: r => none.push(r) })(URL),
    /price_cap_exceeded/,
  );
  await new Promise(r => setTimeout(r, 20));
  assert.equal(none.length, 0);
  assert.equal(over.state.signs, 0);
});
