/**
 * LIVE integration check for the trust-gate core against the real TWZRD preflight.
 *
 * The unit suite (gate.test.ts) mocks fetch with the 2026-06-14 fixtures. This
 * test proves the SAME guard, hitting the REAL gate, still produces the organic
 * intercept — closing the "is the mock still true?" gap. It is the TS twin of
 * packages/twzrd-agent-intel demand_proof_loop.py.
 *
 * Network-gated so CI stays offline by default:
 *   TWZRD_LIVE_GATE=1 npx tsx test/gate.live.test.ts
 *
 * Proof case (real, non-twzrd merchants on the live PayAI rail):
 *   34w53Ukhf4Bv5SZjU8Dez76r8fhxaKvdqc4eoCzeete6  -> decision=block (wash-flagged, captive 91.4%)  MUST block
 *   7uh2ibD1nAoL9UohbaNTubsMZK5321cKB8E8kPQQVZyj  -> decision=warn  (clean hub)                     MUST NOT hard-block
 *
 * Honest framing: on the free preflight a clean-unknown seller sits at `warn`
 * (canSpend=false) too. The guard's hard-BLOCK fires only for the flagged seller;
 * that block-vs-warn discrimination is the live intercept this test pins.
 */
import assert from "node:assert";
import { checkTrust } from "../src/gate.ts";

const FLAGGED = "34w53Ukhf4Bv5SZjU8Dez76r8fhxaKvdqc4eoCzeete6";
const CLEAN = "7uh2ibD1nAoL9UohbaNTubsMZK5321cKB8E8kPQQVZyj";

// Cloudflare 403s the default runtime UA on some hosts (see agent-intel ed4e49eb).
// Wrap fetch to send a real UA so the live call is not bounced.
const liveFetch: typeof fetch = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
  fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), "user-agent": "twzrd-plugin-trustgate-livetest/1.0" },
  })) as typeof fetch;

async function main() {
  if (process.env.TWZRD_LIVE_GATE !== "1") {
    console.log("SKIP gate.live.test.ts (set TWZRD_LIVE_GATE=1 to run against intel.twzrd.xyz)");
    return;
  }

  const cfg = { fetchImpl: liveFetch, timeoutMs: 8000 };

  const flagged = await checkTrust(FLAGGED, cfg);
  console.log(`FLAGGED ${FLAGGED.slice(0, 8)} -> decision=${flagged.decision} trust=${flagged.trustScore} blocked=${flagged.blocked} gateAvailable=${flagged.gateAvailable}`);
  assert.equal(flagged.gateAvailable, true, "live gate must be reachable (UA 403? outage?)");
  assert.equal(flagged.decision, "block", "live: flagged wash seller must return decision=block");
  assert.equal(flagged.blocked, true, "live: guard must block the flagged seller");

  const clean = await checkTrust(CLEAN, cfg);
  console.log(`CLEAN   ${CLEAN.slice(0, 8)} -> decision=${clean.decision} trust=${clean.trustScore} blocked=${clean.blocked} gateAvailable=${clean.gateAvailable}`);
  assert.equal(clean.gateAvailable, true, "live gate must be reachable");
  assert.notEqual(clean.decision, "block", "live: clean control must NOT be escalated to block");
  assert.equal(clean.blocked, false, "live: guard must not hard-block the clean control");

  // The intercept: flagged got a strictly harsher decision than the clean control.
  assert.equal(flagged.decision === "block" && clean.decision !== "block", true,
    "live organic intercept: flagged blocked while clean control not escalated");

  console.log("OK gate.live.test.ts - LIVE ORGANIC INTERCEPT confirmed (block vs warn).");
}

main().catch((e) => {
  console.error("FAIL gate.live.test.ts:", e);
  process.exit(1);
});
