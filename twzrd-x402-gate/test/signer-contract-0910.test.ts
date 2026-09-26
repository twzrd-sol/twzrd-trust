/**
 * 0.9.12 signer contract. Calls the shipped buyer approval, before-payment
 * hook, and settle guard. Run: npx tsx test/signer-contract-0910.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { twzrdApprovePayment } from "../src/policy.js";
import { resolveConfig } from "../src/config.js";
import { createTwzrdBeforePaymentHook } from "../src/x402-client-hook.js";
import { createTwzrdSettleGuard } from "../src/seller-hook.js";

const require = createRequire(import.meta.url);
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE = "eip155:8453";
const POLYGON = "eip155:137";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function intelFetch(card: Record<string, unknown>, urls: string[]): typeof fetch {
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/v1/intel/preflight")) {
      return jsonResponse({ readiness_card: card });
    }
    if (url.includes("/v1/intel/merchant_card/")) {
      return jsonResponse({ wash_flagged: null, in_corpus: false });
    }
    throw new Error(`unexpected intel url ${url}`);
  };
  return impl;
}

async function run() {
  const pkg = require("../package.json") as { version: string; description: string };
  assert.equal(pkg.version, "0.9.12");
  console.log(`version 0.9.12`);

  const shipped = ["README.md", "QUICKSTART.md", "src/doctor.ts"];
  for (const rel of shipped) {
    const text = readFileSync(join(pkgRoot, rel), "utf8");
    const hits = text.match(/npm install twzrd-x402-gate\S*/g) ?? [];
    assert.ok(hits.length > 0, `${rel} ships an install string`);
    for (const hit of hits) {
      assert.ok(
        hit.includes(`@${pkg.version}`),
        `${rel} install must pin @${pkg.version}: ${hit}`,
      );
    }
  }
  const compat = readFileSync(join(pkgRoot, "COMPATIBILITY.md"), "utf8");
  assert.match(compat, /0\.9\.12 is the released identity/);
  assert.doesNotMatch(pkg.description, /Fail-closed by default/);
  assert.match(pkg.description, /not uniformly fail-closed/);
  assert.match(pkg.description, /Base mainnet \(eip155:8453\)/);
  assert.match(
    pkg.description,
    /createTwzrdBeforePaymentHook does not read TWZRD_AUTO_GATE or TWZRD_GATE_ENABLED/,
  );

  const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
  assert.match(readme, /Solana mainnet and Base mainnet \(`eip155:8453`\)/);
  assert.doesNotMatch(readme, /only \*\*reputation-scores Solana mainnet\*\*/);
  assert.doesNotMatch(readme, /any non-Solana payTo/);
  assert.match(readme, /`createTwzrdBeforePaymentHook` does not read those/);
  assert.match(readme, /null_reason: unknown_subject` \(or `score: null`\) is not a low score/);
  assert.match(readme, /price is above `recommended_cap_usdc`/);
  assert.match(readme, /omitted `failOpen` on `createTwzrdSettleGuard` is a different default/);
  assert.match(
    readme,
    /twzrdApprovePayment` returns `approved: false` with reason `twzrd_fail_closed` and the wallet does not sign/,
  );
  assert.match(readme, /`eip155:137` does not run `twzrdPreflight` or the scored preflight/);
  assert.match(readme, /returns reason `twzrd_unevaluated_subject_unknown_subject`/);
  assert.match(readme, /starts with `twzrd_over_recommended_cap_`/);
  assert.match(readme, /returns reason `twzrd_decision_block`/);
  assert.match(readme, /That reason string is not `block` and is not `twzrd_fail_closed`/);
  assert.match(readme, /That reason is not `twzrd_missing_payTo`/);
  assert.match(readme, /That reason is not `twzrd_preflight_fetch_error`/);
  assert.match(
    readFileSync(join(pkgRoot, "src/x402-client-hook.ts"), "utf8"),
    /That reason string is not `block` and is not `twzrd_fail_closed`/,
  );
  assert.match(
    readFileSync(join(pkgRoot, "src/seller-hook.ts"), "utf8"),
    /Omitted failOpen is fail-open\. A thrown screen returns without abort\./,
  );
  assert.doesNotMatch(readme, /unknown\/uncertain seller at `warn`, which \*\*proceeds\*\*/);
  const typesSrc = readFileSync(join(pkgRoot, "src/types.ts"), "utf8");
  assert.doesNotMatch(typesSrc, /Base\/EVM/);
  const configSrc = readFileSync(join(pkgRoot, "src/config.ts"), "utf8");
  assert.doesNotMatch(configSrc, /Base\/EVM/);
  assert.match(configSrc, /can_spend false alone does not block/);
  const quickstart = readFileSync(join(pkgRoot, "QUICKSTART.md"), "utf8");
  assert.match(
    quickstart,
    /`createTwzrdPayKitBeforePaymentHook` does not read `TWZRD_AUTO_GATE`/,
  );
  const autoGateSrc = readFileSync(join(pkgRoot, "src/auto-gate.ts"), "utf8");
  assert.doesNotMatch(autoGateSrc, /Kill switch \(any\)/);
  assert.doesNotMatch(autoGateSrc, /Process-wide kill/);
  assert.match(
    autoGateSrc,
    /createTwzrdBeforePaymentHook itself does not[\s\S]{0,40}read TWZRD_AUTO_GATE or TWZRD_GATE_ENABLED/,
  );

  const savedFail = process.env.TWZRD_FAIL_OPEN;
  const savedGate = process.env.TWZRD_GATE_ENABLED;
  const savedAuto = process.env.TWZRD_AUTO_GATE;
  delete process.env.TWZRD_FAIL_OPEN;
  try {
    const urls: string[] = [];
    const missing = await twzrdApprovePayment(
      {},
      resolveConfig({ fetch: intelFetch({}, urls) }),
    );
    assert.equal(missing.approved, false);
    assert.equal(missing.reason, "twzrd_unidentifiable_payment_recipient");
    assert.equal(urls.length, 0);
    console.log("missing-payTo not approved");

    const outage = await twzrdApprovePayment(
      { payTo: SELLER, chain: SOL },
      resolveConfig({
        fetch: (async () => {
          throw new Error("intel down");
        }) as typeof fetch,
      }),
    );
    assert.equal(outage.approved, false);
    assert.equal(outage.failOpen, false);
    assert.match(outage.reason, /twzrd_fail_closed/);
    console.log("default buyer outage not approved");

    for (const network of [SOL, BASE]) {
      const hook = createTwzrdBeforePaymentHook({
        fetch: intelFetch(
          {
            decision: "warn",
            trust_score: 45,
            score: null,
            null_reason: "unknown_subject",
            can_spend: true,
            seller_wallet: SELLER,
            recommended_cap_usdc: 0.01,
          },
          [],
        ),
      });
      const result = await hook({
        payTo: SELLER,
        network,
        amount: "10000",
        resource: "https://merchant.example/paid",
      });
      assert.ok(result && result.abort === true, network);
      assert.match(String(result.reason), /unknown_subject/);
    }
    console.log("unknown_subject not signed on a scored network");

    const over = await twzrdApprovePayment(
      { payTo: SELLER, chain: SOL, priceUsdc: 2.5 },
      resolveConfig({
        fetch: intelFetch(
          {
            decision: "warn",
            trust_score: 57.1,
            score: 0.571,
            null_reason: null,
            can_spend: false,
            seller_wallet: SELLER,
            recommended_cap_usdc: 1,
          },
          [],
        ),
        refuseWashFlagged: false,
      }),
    );
    assert.equal(over.approved, false);
    assert.match(over.reason, /twzrd_over_recommended_cap/);
    console.log("over-cap not approved");

    const paid: string[] = [];
    const payingFetch: typeof fetch = async (input) => {
      paid.push(String(input));
      return jsonResponse({ score: 80, tier: "Silver" });
    };
    const warnHook = createTwzrdBeforePaymentHook({
      fetch: intelFetch(
        {
          decision: "warn",
          trust_score: 57.1,
          score: 0.571,
          null_reason: null,
          can_spend: true,
          seller_wallet: SELLER,
          recommended_cap_usdc: 10,
        },
        [],
      ),
      x402Fetch: payingFetch,
    });
    const warnResult = await warnHook({
      payTo: SELLER,
      network: SOL,
      amount: "500000",
      resource: "https://merchant.example/paid",
    });
    assert.equal(warnResult, undefined);
    const joined = paid.join(" ");
    assert.match(joined, /\/v1\/intel\/quick\//);
    assert.doesNotMatch(joined, /\/v1\/intel\/trust\//);
    console.log(`warn URL containing /v1/intel/quick/ and not /v1/intel/trust/ (${joined})`);

    const polygonUrls: string[] = [];
    const polygon = createTwzrdBeforePaymentHook({
      fetch: intelFetch(
        { decision: "allow", trust_score: 90, score: 0.9, seller_wallet: SELLER },
        polygonUrls,
      ),
    });
    await polygon({
      payTo: "0x1111111111111111111111111111111111111111",
      network: POLYGON,
      amount: "10000",
      resource: "https://merchant.example/paid",
    });
    assert.equal(
      polygonUrls.some((u) => u.includes("/v1/intel/preflight")),
      false,
    );
    console.log("non-Base EVM call that never requests scored preflight");

    process.env.TWZRD_GATE_ENABLED = "false";
    process.env.TWZRD_AUTO_GATE = "0";
    const killed = createTwzrdBeforePaymentHook({
      fetch: intelFetch(
        {
          decision: "block",
          trust_score: 5,
          score: 0.05,
          null_reason: null,
          can_spend: false,
          seller_wallet: SELLER,
        },
        [],
      ),
      refuseWashFlagged: false,
    });
    const killedResult = await killed({
      payTo: SELLER,
      network: SOL,
      amount: "10000",
      resource: "https://merchant.example/paid",
    });
    assert.ok(killedResult && killedResult.abort === true);
    console.log(
      "before-payment hook still aborting a bad payment when TWZRD_GATE_ENABLED=false and TWZRD_AUTO_GATE=0",
    );

    const guard = createTwzrdSettleGuard({
      screen: () => {
        throw new Error("gate down");
      },
    });
    const settled = await guard({ paymentPayload: { payload: { payer: SELLER } } });
    assert.equal(settled, undefined);
    console.log("default settle guard returning without abort when the gate is down");
  } finally {
    if (savedFail === undefined) delete process.env.TWZRD_FAIL_OPEN;
    else process.env.TWZRD_FAIL_OPEN = savedFail;
    if (savedGate === undefined) delete process.env.TWZRD_GATE_ENABLED;
    else process.env.TWZRD_GATE_ENABLED = savedGate;
    if (savedAuto === undefined) delete process.env.TWZRD_AUTO_GATE;
    else process.env.TWZRD_AUTO_GATE = savedAuto;
  }

  console.log("signer-contract-0910.test.ts: ALL PASSED");
}

run().catch((err) => {
  console.error("signer-contract-0910.test.ts FAILED:", err);
  process.exit(1);
});
