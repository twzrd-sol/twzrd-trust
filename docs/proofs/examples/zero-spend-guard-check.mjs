#!/usr/bin/env node
/**
 * Zero-spend TWZRD pay-guard check.
 *
 * Proves: preflight runs, strict gate blocks, signer is never invoked.
 * No wallet funding or settlement required.
 *
 * Usage:
 *   npm i twzrd-x402-gate@0.5.3
 *   node zero-spend-guard-check.mjs
 *
 * Optional:
 *   TWZRD_TEST_URL=https://example.com/paid node zero-spend-guard-check.mjs
 */
import { installTwzrdAutoGate } from "twzrd-x402-gate";

const TARGET =
  process.env.TWZRD_TEST_URL?.trim() ||
  "https://intel.twzrd.xyz/v1/intel/quick/4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE";

let signInvocations = 0;

/** Instrumented pay client: counts would-be sign paths, never spends USDC. */
function instrumentedPayWrap(guarded) {
  return async (input, init) => {
    const resp = await guarded(input, init);
    if (resp.status === 402) {
      signInvocations += 1;
      throw new Error("signer would be invoked (instrumented abort)");
    }
    return resp;
  };
}

const payingFetch = installTwzrdAutoGate(instrumentedPayWrap, {
  gateOnCanSpend: true,
  failOpen: false,
});

let blocked = false;
let reason = "";
let decision = null;

try {
  await payingFetch(TARGET);
} catch (err) {
  blocked = true;
  reason = String(err?.message ?? err);
  const m = reason.match(/twzrd_[a-z0-9_]+/i);
  if (m) reason = m[0];
}

const out = {
  target: TARGET,
  blocked,
  reason: blocked ? reason : "allowed",
  signInvocations,
  expectedStrictBlock: {
    reason: "twzrd_can_spend_false",
    signInvocations: 0,
  },
  pass:
    blocked &&
    signInvocations === 0 &&
    (reason.includes("twzrd_can_spend_false") ||
      reason.includes("payment blocked")),
};

console.log(JSON.stringify(out, null, 2));
process.exit(out.pass ? 0 : 1);