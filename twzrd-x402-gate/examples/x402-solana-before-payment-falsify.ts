#!/usr/bin/env -S npx tsx
/**
 * S1 falsification harness - proves the beforePayment gate CAN fail to block.
 *
 * `x402-solana-before-payment-proof` shows the gate refusing a wash_flagged
 * payTo before signing. On its own that is not evidence the gate discriminates:
 * a hook hardcoded to `{ abort: true }` would produce an identical green proof.
 * This harness supplies the missing controls. All three arms run through the
 * SAME real x402-solana@2.1.0 stock client against LIVE intel:
 *
 *   ARM A  wash payTo  + refuseWashFlagged:true   -> EXPECT abort  (gate fires)
 *   ARM B  clean payTo + refuseWashFlagged:true   -> EXPECT no abort (merchant-dependent)
 *   ARM C  wash payTo  + refuseWashFlagged:false  -> EXPECT no abort (gate-dependent)
 *
 * B proves the refusal tracks the MERCHANT. C proves it tracks the GATE BEING ON.
 * If any arm disagrees, the S1 proof is hollow and this exits non-zero.
 *
 * In the allow arms the client proceeds past the gate into transaction
 * construction and fails there on the placeholder wallet ("Non-base58
 * character"). That failure is the evidence of passage: it originates from the
 * signer path, not from the gate. No arm ever signs, so no arm can spend.
 *
 * Does NOT spend USDC. Does NOT require a funded wallet.
 *
 * Run from package root:
 *   npm run x402-solana-before-payment-falsify
 *
 * Env:
 *   TWZRD_INTEL_BASE  default https://intel.twzrd.xyz
 *   WASH_PAYTO        default BJGdsDXJ... (live wash_flagged=true)
 *   CLEAN_PAYTO       default X4o2D8op... (live wash_flagged=false)
 */
import { createTwzrdBeforePaymentHook } from "../src/x402-client-hook.js";

const INTEL = (process.env.TWZRD_INTEL_BASE || "https://intel.twzrd.xyz").replace(/\/+$/, "");
const WASH = process.env.WASH_PAYTO?.trim() || "BJGdsDXJFy63eCAnX3UmGfShp8BuqbtkTfcamyRGr7VQ";
const CLEAN = process.env.CLEAN_PAYTO?.trim() || "X4o2D8op42a2jcNJJVZcDq3eYivh1oR9XiezPWCXosZ";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type ArmResult = {
  arm: string;
  payTo: string;
  refuseWashFlagged: boolean;
  aborted: boolean;
  verdict: string | null;
  reason: string | null;
  signer_invocations: number;
  fetch_calls: number;
  err: string | null;
};

async function arm(name: string, payTo: string, refuseWashFlagged: boolean): Promise<ArmResult> {
  const mod = (await import("x402-solana")) as unknown as {
    createX402Client: (cfg: Record<string, unknown>) => { fetch: typeof fetch };
  };
  const createX402Client = mod.createX402Client;
  const resource = `${INTEL}/v1/intel/trust/${payTo}`;
  const signer = { n: 0 };

  const wallet = {
    publicKey: { toString: () => "TwzrdProofWallet1111111111111111111111111" },
    address: "TwzrdProofWallet1111111111111111111111111",
    signTransaction: async <T>(tx: T): Promise<T> => {
      signer.n += 1;
      return tx;
    },
  };

  const challenge = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: resource, description: "falsify", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "solana:mainnet",
        maxAmountRequired: "50000",
        amount: "50000",
        resource,
        description: "falsify",
        mimeType: "application/json",
        payTo,
        maxTimeoutSeconds: 60,
        asset: USDC,
        extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" },
      },
    ],
  };

  let calls = 0;
  const customFetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify(challenge), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  let verdict: string | null = null;
  let reason: string | null = null;
  const beforePayment = createTwzrdBeforePaymentHook({
    refuseWashFlagged,
    gateOnCanSpend: false,
    preflightMinScore: 0,
    failOpen: true,
    intelBase: INTEL,
    onDecision: (d) => {
      verdict = d.verdict;
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

  let aborted = false;
  let err: string | null = null;
  try {
    await client.fetch(resource);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
    if (/aborted by beforePayment|beforePayment hook|\[twzrd\]/i.test(err)) aborted = true;
  }

  return {
    arm: name,
    payTo,
    refuseWashFlagged,
    aborted,
    verdict,
    reason,
    signer_invocations: signer.n,
    fetch_calls: calls,
    err,
  };
}

async function polarity(wallet: string): Promise<boolean | null> {
  const r = await fetch(`${INTEL}/v1/intel/merchant_card/${wallet}`);
  if (!r.ok) return null;
  const j = (await r.json()) as { wash_flagged?: boolean };
  return j.wash_flagged ?? null;
}

async function main() {
  // Fixtures must have the polarity the arms assume, or the controls prove nothing.
  const washFlag = await polarity(WASH);
  const cleanFlag = await polarity(CLEAN);
  if (washFlag !== true || cleanFlag !== false) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "fixture_polarity_invalid",
        wash: { wallet: WASH, wash_flagged: washFlag, expected: true },
        clean: { wallet: CLEAN, wash_flagged: cleanFlag, expected: false },
        hint: "Pick fixtures from GET /v1/intel/sellers and set WASH_PAYTO / CLEAN_PAYTO",
      }),
    );
    process.exit(2);
  }

  const a = await arm("A_wash_gateON", WASH, true);
  const b = await arm("B_clean_gateON", CLEAN, true);
  const c = await arm("C_wash_gateOFF", WASH, false);

  // The discriminator is whether the payment was REFUSED, not the verdict label.
  // Arm C legitimately reports verdict "warn": the merchant is still wash_flagged
  // so intel still surfaces the signal, but with refuseWashFlagged:false the gate
  // declines to enforce it. Signal surfaced != payment refused.
  const checks = {
    // Positive control: gate on + dirty merchant => refuse before sign.
    A_blocks_wash: a.aborted === true && a.verdict === "block" && a.signer_invocations === 0,
    // Merchant control: same config, clean merchant => must NOT refuse.
    B_allows_clean: b.aborted === false && b.verdict !== "block",
    // Gate control: same dirty merchant, gate off => must NOT refuse.
    C_allows_gate_off: c.aborted === false && c.verdict !== "block",
    // Safety: no arm may ever reach the signer in this harness.
    no_arm_signs:
      a.signer_invocations === 0 && b.signer_invocations === 0 && c.signer_invocations === 0,
  };
  const discriminating = Object.values(checks).every(Boolean);

  console.log(
    JSON.stringify(
      {
        ok: discriminating,
        fixtures: {
          wash: { wallet: WASH, wash_flagged: washFlag },
          clean: { wallet: CLEAN, wash_flagged: cleanFlag },
        },
        arms: [a, b, c],
        checks,
        discriminating,
        interpretation: discriminating
          ? "Refusal tracks BOTH the merchant wash flag and the gate being enabled - the S1 proof is not a constant-block."
          : "Gate did NOT discriminate. The S1 green proof does not establish selective refusal.",
      },
      null,
      2,
    ),
  );

  if (!discriminating) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
