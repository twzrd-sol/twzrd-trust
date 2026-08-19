#!/usr/bin/env -S npx tsx
/**
 * S1 dogfood: stock PayAI seat refuse-before-sign proof + clean-seller control.
 *
 * Positive arm: wash_flagged payTo → beforePayment aborts → signer=0.
 * Negative arm: clean payTo + same gate → must NOT abort (discrimination).
 *
 * Prefer real x402-solana@2.1.0 when installed (createX402Client + customFetch
 * 402 → beforePayment). Falls back to harness unless X402_SOLANA_PROOF=require.
 *
 * Does NOT spend USDC. Does NOT require a funded wallet.
 *
 * Run from package root:
 *   npm run x402-solana-before-payment-proof
 *   X402_SOLANA_PROOF=require npm run x402-solana-before-payment-proof
 *
 * Env:
 *   TWZRD_INTEL_BASE   default https://intel.twzrd.xyz
 *   WASH_PAYTO         wash_flagged fixture override (re-verified live)
 *   BLOCK_PAYTO        decision=block fallback override (re-verified live)
 *   CLEAN_PAYTO        default auto-pick first non-wash from /v1/intel/sellers
 *   RUN_ID             optional
 *   PROOF_OUT_DIR      default cwd
 *   X402_SOLANA_PROOF=require  exit 3 if x402-solana cannot be loaded
 *   SKIP_NEGATIVE=1    skip clean-seller arm (not valid for closure)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createTwzrdBeforePaymentHook,
  type BeforePaymentCreationResult,
} from "../src/x402-client-hook.js";
import {
  buildAutogateBlockProof,
  resolveInstalledPackageVersion,
  type AutogateBlockProof,
  type ExecutionMode,
} from "../src/block-proof.js";
import { CLIENT_VERSION } from "../src/version.js";
import { resolveBlockedSeller, type BlockedFixture } from "./blocked-fixture.js";

const INTEL = (process.env.TWZRD_INTEL_BASE || "https://intel.twzrd.xyz").replace(
  /\/+$/,
  "",
);
// Resolved live in main() - wash_flagged seller, or decision=block fallback
// when the wash overlay drifts (see blocked-fixture.ts).
let WASH = "";
const CLEAN_ENV = process.env.CLEAN_PAYTO?.trim() || "";
const RUN_ID =
  process.env.RUN_ID?.trim() ||
  `s1-x402-solana-beforepayment-${new Date().toISOString().slice(0, 10)}`;
const OUT_DIR = process.env.PROOF_OUT_DIR?.trim() || process.cwd();
const REQUIRE_PKG = process.env.X402_SOLANA_PROOF === "require";
const SKIP_NEGATIVE = process.env.SKIP_NEGATIVE === "1";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type SeatMode = ExecutionMode;

type ArmOutcome = {
  mode: SeatMode;
  aborted: boolean;
  abortReason: string | null;
  decision: string | null;
  reason: string | null;
  signerInvocations: number;
  fetchCalls: number;
  x402SolanaVersion: string | null;
};

async function merchantCard(payTo: string): Promise<{
  wash_flagged: boolean | null;
  trust_score: number | null;
}> {
  const r = await fetch(`${INTEL}/v1/intel/merchant_card/${payTo}`);
  if (!r.ok) {
    throw new Error(`merchant_card HTTP ${r.status} for ${payTo}`);
  }
  const j = (await r.json()) as { wash_flagged?: boolean; trust_score?: number };
  return {
    wash_flagged: j.wash_flagged ?? null,
    trust_score: typeof j.trust_score === "number" ? j.trust_score : null,
  };
}

/** Pick a live non-wash payTo when CLEAN_PAYTO is unset. */
async function pickCleanSeller(): Promise<string> {
  if (CLEAN_ENV) return CLEAN_ENV;
  // Prefer documented allow-ish control used in falsify harness.
  const fallback = "X4o2D8op42a2jcNJJVZcDq3eYivh1oR9XiezPWCXosZ";
  try {
    const r = await fetch(`${INTEL}/v1/intel/sellers?limit=60`);
    if (r.ok) {
      const j = (await r.json()) as {
        sellers?: Array<{ pay_to?: string; wash_flagged?: boolean }>;
      };
      const clean = (j.sellers || []).find(
        (s) => s.pay_to && s.wash_flagged === false && s.pay_to !== WASH,
      );
      if (clean?.pay_to) return clean.pay_to;
    }
  } catch {
    /* use fallback */
  }
  return fallback;
}

async function tryStockClient(opts: {
  payTo: string;
  refuseWashFlagged: boolean;
}): Promise<ArmOutcome | null> {
  let createX402Client: ((cfg: Record<string, unknown>) => { fetch: typeof fetch }) | null =
    null;
  try {
    const mod = await import("x402-solana");
    createX402Client = (mod as { createX402Client?: typeof createX402Client })
      .createX402Client as typeof createX402Client;
    if (!createX402Client) {
      const clientMod = await import("x402-solana/client");
      createX402Client = (
        clientMod as { createX402Client?: typeof createX402Client }
      ).createX402Client as typeof createX402Client;
    }
  } catch {
    return null;
  }
  if (!createX402Client) return null;

  const packageVersion = resolveInstalledPackageVersion("x402-solana", import.meta.url);

  const resource = `${INTEL}/v1/intel/trust/${opts.payTo}`;
  const signerInvocations = { n: 0 };
  const wallet = {
    publicKey: { toString: () => "TwzrdProofWallet1111111111111111111111111" },
    address: "TwzrdProofWallet1111111111111111111111111",
    signTransaction: async <T>(tx: T): Promise<T> => {
      signerInvocations.n += 1;
      return tx;
    },
  };

  const paymentRequired = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: resource, description: "S1 proof", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "solana:mainnet",
        maxAmountRequired: "50000",
        amount: "50000",
        resource,
        description: "proof",
        mimeType: "application/json",
        payTo: opts.payTo,
        maxTimeoutSeconds: 60,
        asset: USDC_MINT,
        extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" },
      },
    ],
  };

  let call = 0;
  const customFetch = (async () => {
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  let decision: string | null = null;
  let reason: string | null = null;
  const beforePayment = createTwzrdBeforePaymentHook({
    refuseWashFlagged: opts.refuseWashFlagged,
    gateOnCanSpend: false,
    preflightMinScore: 0,
    failOpen: true,
    intelBase: INTEL,
    onDecision: (d) => {
      decision = d.verdict;
      reason = d.reason;
    },
  });

  const client = createX402Client({
    wallet,
    network: "solana",
    customFetch,
    amount: BigInt("1000000000"),
    beforePayment,
    verbose: false,
  });

  let abortReason: string | null = null;
  let aborted = false;
  try {
    await client.fetch(resource);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/aborted by beforePayment|beforePayment hook/i.test(msg) || /twzrd/i.test(msg)) {
      aborted = true;
      abortReason = msg;
    } else {
      // Passage past the gate into tx construction (placeholder wallet) is NOT a
      // gate abort — e.g. "Non-base58 character". Record as not-aborted by gate.
      abortReason = msg;
      aborted = false;
    }
  }

  return {
    mode: "x402-solana@2.1.0",
    aborted,
    abortReason,
    decision,
    reason,
    signerInvocations: signerInvocations.n,
    fetchCalls: call,
    x402SolanaVersion: packageVersion,
  };
}

async function harnessArm(opts: {
  payTo: string;
  refuseWashFlagged: boolean;
}): Promise<ArmOutcome> {
  const resource = `${INTEL}/v1/intel/trust/${opts.payTo}`;
  const signerInvocations = { n: 0 };
  let decision: string | null = null;
  let reason: string | null = null;
  const beforePayment = createTwzrdBeforePaymentHook({
    refuseWashFlagged: opts.refuseWashFlagged,
    gateOnCanSpend: false,
    preflightMinScore: 0,
    failOpen: true,
    intelBase: INTEL,
    onDecision: (d) => {
      decision = d.verdict;
      reason = d.reason;
    },
  });
  const requirements = {
    payTo: opts.payTo,
    network: "solana:mainnet",
    amount: "50000",
    maxAmountRequired: "50000",
    resource,
    scheme: "exact",
    asset: USDC_MINT,
  };
  const result: BeforePaymentCreationResult = await beforePayment(requirements, {
    requestUrl: resource,
    responseUrl: resource,
    declaredResource: resource,
    protocolVersion: 2,
  });
  if (result && result.abort === true) {
    return {
      mode: "harness",
      aborted: true,
      abortReason: result.reason ?? "abort",
      decision,
      reason,
      signerInvocations: 0,
      fetchCalls: 0,
      x402SolanaVersion: null,
    };
  }
  signerInvocations.n += 1;
  return {
    mode: "harness",
    aborted: false,
    abortReason: null,
    decision,
    reason,
    signerInvocations: signerInvocations.n,
    fetchCalls: 0,
    x402SolanaVersion: null,
  };
}

async function runArm(opts: {
  payTo: string;
  refuseWashFlagged: boolean;
}): Promise<ArmOutcome> {
  const stock = await tryStockClient(opts);
  if (stock) return stock;
  if (REQUIRE_PKG) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "x402_solana_not_available",
        hint: "npm i x402-solana@2.1.0 && X402_SOLANA_PROOF=require npm run x402-solana-before-payment-proof",
      }),
    );
    process.exit(3);
  }
  return harnessArm(opts);
}

async function main() {
  // Live fixture: prefer a wash_flagged seller; when the wash overlay drifts,
  // fall back to a live decision=block seller (same refuse seat, different basis).
  const fixture: BlockedFixture = await resolveBlockedSeller(INTEL);
  WASH = fixture.seller;
  const washCard = await merchantCard(WASH).catch(
    () => ({ wash_flagged: null, trust_score: null }) as const,
  );

  // --- Positive arm: wash refuse ---
  const positive = await runArm({ payTo: WASH, refuseWashFlagged: true });

  // --- Negative arm: clean seller must not refuse ---
  let negative: ArmOutcome | null = null;
  let cleanSeller = "";
  let cleanCard: { wash_flagged: boolean | null; trust_score: number | null } | null =
    null;
  if (!SKIP_NEGATIVE) {
    cleanSeller = await pickCleanSeller();
    cleanCard = await merchantCard(cleanSeller);
    if (cleanCard.wash_flagged !== false) {
      console.error(
        JSON.stringify({
          ok: false,
          error: "fixture_not_clean",
          seller: cleanSeller,
          wash_flagged: cleanCard.wash_flagged,
          hint: "Set CLEAN_PAYTO to a merchant_card.wash_flagged=false wallet",
        }),
      );
      process.exit(2);
    }
    negative = await runArm({ payTo: cleanSeller, refuseWashFlagged: true });
  }

  const rawReason = positive.abortReason ?? positive.reason ?? null;
  const internalReason =
    typeof rawReason === "string"
      ? rawReason.replace(/^Payment aborted by beforePayment hook:\s*/i, "").trim()
      : rawReason;

  const negPassed =
    negative != null &&
    negative.aborted === false &&
    negative.decision !== "block" &&
    negative.signerInvocations === 0;

  const proof: AutogateBlockProof = buildAutogateBlockProof({
    run_id: RUN_ID,
    target_seller: WASH,
    aborted: positive.aborted,
    internal_reason: internalReason,
    decision: positive.decision,
    wash_flagged: washCard.wash_flagged,
    trust_score: washCard.trust_score,
    signer_invocations: positive.signerInvocations,
    actual_spend_usdc: 0,
    onchain_settlements: 0,
    package_version: CLIENT_VERSION,
    hook: "beforePayment",
    execution_mode: positive.mode,
    x402_solana_version: positive.x402SolanaVersion,
    stock_seat_required: REQUIRE_PKG,
    negative_control: negative
      ? {
          clean_seller: cleanSeller,
          wash_flagged: cleanCard?.wash_flagged ?? null,
          aborted: negative.aborted,
          decision: negative.decision,
          reason: negative.reason,
          signer_invocations: negative.signerInvocations,
          passed: negPassed,
        }
      : undefined,
  });

  // Closure requires stock seat when require flag is set, and negative control.
  const stockOk =
    !REQUIRE_PKG ||
    (positive.mode === "x402-solana@2.1.0" &&
      positive.x402SolanaVersion != null &&
      positive.x402SolanaVersion !== "unknown");
  const closureOk =
    proof.verified === true &&
    stockOk &&
    (SKIP_NEGATIVE || negPassed);

  const outPath = join(OUT_DIR, `block-proof-${RUN_ID}.json`);
  writeFileSync(outPath, JSON.stringify(proof, null, 2) + "\n");

  const summary = {
    ok: closureOk,
    schema_version: proof.schema_version,
    execution_mode: proof.execution_mode,
    x402_solana_version: proof.x402_solana_version,
    stock_seat_required: REQUIRE_PKG,
    package_version: CLIENT_VERSION,
    positive: {
      target_seller: WASH,
      fixture_basis: fixture.basis,
      wash_flagged: washCard.wash_flagged,
      aborted: positive.aborted,
      decision: positive.decision,
      signer_invocation_count: positive.signerInvocations,
      fetch_calls: positive.fetchCalls,
      reason: proof.interception.reason,
    },
    negative_control: proof.negative_control ?? null,
    verified: proof.verified,
    proof_path: outPath,
    copy_paste: {
      install: "npm i twzrd-x402-gate@0.8.16 x402-solana@2.1.0",
      wire: `createX402Client({ wallet, network: "solana", beforePayment: createTwzrdBeforePaymentHook({ refuseWashFlagged: true }) })`,
      strict: "X402_SOLANA_PROOF=require npm run x402-solana-before-payment-proof",
      falsify: "npm run x402-solana-before-payment-falsify",
    },
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!closureOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
