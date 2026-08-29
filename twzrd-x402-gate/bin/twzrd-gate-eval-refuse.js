#!/usr/bin/env node
/**
 * Buyer protection loop — refuse transcript (no USDC when block fires).
 *
 * Success (north-star fields):
 *   target_url, pay_to, twzrd_decision, twzrd_reason,
 *   signer_invocation_count (=0), payment_retry_count (=0)
 *
 * Does NOT increment intel day0.gate_evals (that counter is Path B settle-gate).
 *
 * Usage (after npm install of this package + @x402/* peers):
 *   node node_modules/twzrd-x402-gate/bin/twzrd-gate-eval-refuse.js
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

// Owned TWZRD refuse dogfood (not a third-party brand). Live 402 + force hard-block.
const TARGET_URL = "https://intel.twzrd.xyz/v1/intel/refuse-fixture";
const EXPECT_PAYTO = "CnTmHDXVEafkc8sFSzNky9w5zwk63Bk2mHZZodorjhvR";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const INTEL_PREFLIGHT = "https://intel.twzrd.xyz/v1/intel/preflight";
const SIGNER_SPY_STOP = "TWZRD_SIGNER_SPY_STOP_BEFORE_SIGNATURE";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const require = createRequire(import.meta.url);

function resolveImport(spec) {
  try {
    return require.resolve(spec);
  } catch {
    return null;
  }
}

async function loadHook() {
  const dist = join(pkgRoot, "dist", "x402-client-hook.js");
  const src = join(pkgRoot, "src", "x402-client-hook.ts");
  if (existsSync(dist)) {
    return import(pathToFileURL(dist).href);
  }
  if (existsSync(src)) {
    // Dev checkout: prefer compiled; otherwise dynamic tsx is out of scope for bin.
    console.error(
      "twzrd-gate-eval-refuse: run `npm run build` in twzrd-x402-gate or install the published package",
    );
    process.exit(2);
  }
  console.error("twzrd-gate-eval-refuse: package dist missing");
  process.exit(2);
}

async function immediatePreflight() {
  const res = await fetch(INTEL_PREFLIGHT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      seller_wallet: EXPECT_PAYTO,
      price_usdc: 0.001,
    }),
  });
  if (!res.ok) {
    throw new Error(`preflight HTTP ${res.status}`);
  }
  const body = await res.json();
  const card = body.readiness_card ?? body;
  if (card.decision !== "block" || card.can_spend !== false) {
    throw new Error(
      `refuse fixture drifted: expected block/can_spend=false, got ${card.decision}/${card.can_spend}`,
    );
  }
  return card;
}

async function main() {
  // Recommend our OWN version, read at runtime - a hardcoded literal here
  // shipped a two-release downgrade inside the published tarball (0.8.12's
  // bin told agents to install 0.8.10).
  const ownVersion = require("../package.json").version;
  for (const pkg of ["@x402/core", "@x402/fetch", "@x402/svm", "@solana/kit"]) {
    if (!resolveImport(pkg)) {
      console.error(
        `twzrd-gate-eval-refuse: missing peer ${pkg}. Run:\n` +
          `  npm install twzrd-x402-gate@${ownVersion} @x402/core @x402/fetch @x402/svm @solana/kit @scure/base`,
      );
      process.exit(2);
    }
  }

  const preflight = await immediatePreflight();

  const { generateKeyPairSigner } = await import("@solana/kit");
  const { x402Client } = await import("@x402/core/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { ExactSvmScheme } = await import("@x402/svm/exact/client");
  const { installTwzrdX402ClientHook } = await loadHook();

  const ephemeral = await generateKeyPairSigner();
  let signerInvocationCount = 0;
  let paymentRetryCount = 0;
  let gateDecision = null;

  const signerSpy = {
    address: ephemeral.address,
    async signTransactions() {
      signerInvocationCount += 1;
      throw new Error(SIGNER_SPY_STOP);
    },
  };

  const observedFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (
      headers.has("payment-signature") ||
      headers.has("x-payment") ||
      headers.has("payment")
    ) {
      paymentRetryCount += 1;
    }
    return fetch(input, init);
  };

  const client = new x402Client();
  client.register(NETWORK, new ExactSvmScheme(signerSpy));

  client.onBeforePaymentCreation(async ({ selectedRequirements: selected }) => {
    const mismatch =
      selected.payTo !== EXPECT_PAYTO ||
      selected.asset !== USDC ||
      selected.network !== NETWORK;
    if (mismatch) {
      return { abort: true, reason: "fixture mismatch" };
    }
  });

  installTwzrdX402ClientHook(client, {
    failOpen: false,
    gateOnCanSpend: true,
    refuseWashFlagged: true,
    preflightMinScore: 40,
    onDecision(detail) {
      gateDecision = { ...detail };
    },
  });

  const payingFetch = wrapFetchWithPayment(observedFetch, client);
  let observedError = null;
  try {
    await payingFetch(TARGET_URL, { method: "GET" });
  } catch (e) {
    observedError = e instanceof Error ? e.message : String(e);
  }

  const approved = gateDecision?.approved === true;
  const blocked =
    approved === false &&
    signerInvocationCount === 0 &&
    Boolean(observedError?.match(/twzrd|abort|can_spend|wash|block/i));

  const report = {
    schema: "twzrd.gate_eval_refuse.v1",
    lineage: "self_serve_handoff_command",
    closes_external_adoption_metric: false,
    note: "Buyer refuse transcript. day0.gate_evals is settle-gate only — not this path.",
    target_url: TARGET_URL,
    pay_to: EXPECT_PAYTO,
    twzrd_decision: gateDecision?.verdict ?? null,
    twzrd_reason: gateDecision?.reason ?? null,
    signer_invocation_count: signerInvocationCount,
    payment_retry_count: paymentRetryCount,
    usdc_spent: 0,
    preflight_immediately_before_run: {
      decision: preflight.decision,
      can_spend: preflight.can_spend,
    },
    observed_error: observedError,
    verified: blocked,
  };

  console.log("=== FINAL REPORT ===");
  console.log(JSON.stringify(report, null, 2));

  if (!report.verified) {
    console.error("FAIL: expected hard block with signer_invocation_count=0");
    process.exit(1);
  }
  console.error(
    "OK: refuse transcript green (internal self-serve command — not external partner proof)",
  );
}

main().catch((e) => {
  console.error("twzrd-gate-eval-refuse FAILED", e);
  process.exit(1);
});
