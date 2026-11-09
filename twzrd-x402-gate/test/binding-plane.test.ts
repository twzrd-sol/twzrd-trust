import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BINDING_POLICY_SCHEMA,
  PAUSE_SENTINEL_SCHEMA,
  bindingPolicyToGateConfig,
  bindingPolicyToSpendControlOptions,
  checkKillSwitchFile,
  checkPauseSwitchFile,
  parseBindingPolicy,
  readSentinelState,
  writePauseSentinel,
} from "../src/binding-plane.js";
import { twzrdApprovePayment } from "../src/policy.js";
import { spendControlSafeFetch } from "../src/spend-control.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gate-binding-plane-"));
}

test("parseBindingPolicy validates twzrd.binding_policy.v1 and maps payment config", () => {
  const dir = tmpDir();
  try {
    const sharedDoc = {
      schema: BINDING_POLICY_SCHEMA,
      state_dir: path.join(dir, "state"),
      compute: {
        upstream_base_url: "http://127.0.0.1:18080/v1",
        free_models: ["nvidia/nemotron-3.5-bolt"],
        max_tokens_per_minute: 50000,
        max_usd_per_hour: 2.5,
        max_usd_per_day: 10.0,
        max_cost_per_request_usd: 0.2,
        port: 4021,
      },
      payment: {
        max_spend_usdc: "0.25",
        allow_networks: ["solana", "base"],
        preflight_min_score: 55,
        fail_open: false,
        refuse_wash_flagged: true,
        require_offer_binding: true,
        trip_pause_on_block_ms: 45000,
      },
    };

    const parsed = parseBindingPolicy(sharedDoc);
    assert.equal(parsed.schema, "twzrd.binding_policy.v1");

    const gateCfg = bindingPolicyToGateConfig(parsed, dir);
    const spendOpts = bindingPolicyToSpendControlOptions(parsed, dir);

    assert.equal(gateCfg.stateDir, path.resolve(dir, "state"));
    assert.equal(gateCfg.killFilePath, path.resolve(dir, "state", ".kill"));
    assert.equal(gateCfg.pauseFilePath, path.resolve(dir, "state", ".pause"));
    assert.equal(gateCfg.preflightMinScore, 55);
    assert.equal(gateCfg.tripPauseOnBlockMs, 45000);
    assert.equal(spendOpts.maxSpend, "0.25");
    assert.deepEqual(spendOpts.allowNetworks, ["solana", "base"]);
    assert.equal(spendOpts.requireOfferBinding, true);
    assert.equal(spendOpts.tripPauseOnBlockMs, 45000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseBindingPolicy fails closed on unknown keys or malformed values, while section-scoped parsing isolates sections", () => {
  assert.throws(
    () => parseBindingPolicy({ schema: "twzrd.binding_policy.v1", unknown_top: true }),
    /unknown top-level key/i,
  );
  assert.throws(
    () =>
      parseBindingPolicy({
        schema: "twzrd.binding_policy.v1",
        payment: { max_spend_typo: "0.10" } as unknown as Record<string, unknown>,
      }),
    /unknown payment key/i,
  );
  // Section-scoped payment parser ignores compute section typos (P8 section isolation).
  const paymentOnly = parseBindingPolicy(
    {
      schema: "twzrd.binding_policy.v1",
      compute: { bad_compute_key: -1 } as unknown as Record<string, unknown>,
      payment: { max_spend_usdc: "0.10" },
    },
    { section: "payment" },
  );
  assert.equal(paymentOnly.payment?.max_spend_usdc, "0.10");
});

test("sentinel protocol v1: .kill, active .pause, expired .pause, and corrupt .pause enforce fail-closed semantics", () => {
  const dir = tmpDir();
  try {
    const killPath = path.join(dir, ".kill");
    const pausePath = path.join(dir, ".pause");

    // 1. Clean state
    assert.equal(checkKillSwitchFile(killPath), false);
    assert.equal(checkPauseSwitchFile(pausePath, 1000).paused, false);
    assert.equal(readSentinelState({ stateDir: dir, now: 1000 }).active, false);

    // 2. Active .pause written by writePauseSentinel
    const written = writePauseSentinel(pausePath, {
      ttlMs: 30_000,
      reason: "twzrd_wash_flagged",
      decisionId: "dec_cross_1",
      now: 10_000,
    });
    assert.equal(written.schema, PAUSE_SENTINEL_SCHEMA);
    assert.equal(written.until_unix_ms, 40_000);

    const gatePause = checkPauseSwitchFile(pausePath, 25_000);
    assert.equal(gatePause.paused, true);
    assert.equal(gatePause.decisionId, "dec_cross_1");

    // 3. Expired .pause (now >= 40_000)
    const gateExpired = checkPauseSwitchFile(pausePath, 40_000);
    assert.equal(gateExpired.paused, false);
    assert.equal(gateExpired.expired, true);

    // 4. Corrupt .pause fails closed
    fs.writeFileSync(pausePath, "{corrupt");
    assert.equal(checkPauseSwitchFile(pausePath, 50_000).paused, true);
    assert.equal(checkPauseSwitchFile(pausePath, 50_000).corrupt, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Seat 1 payment refusal with tripPauseOnBlockMs writes .pause carrying decision_id and halts subsequent calls", async () => {
  const dir = tmpDir();
  try {
    let intelHits = 0;
    const denyFetch: typeof fetch = (async () => {
      intelHits += 1;
      return new Response(
        JSON.stringify({
          readiness_card: { decision: "block", trust_score: 10, can_spend: false },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    // First payment attempt hits intel, gets blocked, and trips .pause
    const first = await twzrdApprovePayment(
      { sellerWallet: SELLER, priceUsdc: 0.05, chain: SOL, asset: USDC },
      {
        intelBase: "https://intel.example",
        fetch: denyFetch,
        preflightMinScore: 40,
        blockDecisions: new Set(["block"]),
        failOpen: false,
        gateOnCanSpend: false,
        refuseUnevaluated: true,
        refuseUncappedWarn: true,
        intelTimeoutMs: 2000,
        refuseWashFlagged: false,
        refuseWashUnknown: false,
        washMaxUsdc: null,
        unsupportedNetworkMode: "observe",
        stateDir: dir,
        tripPauseOnBlockMs: 60_000,
      },
    );
    assert.equal(first.approved, false);
    assert.equal(first.reason, "twzrd_decision_block");
    assert.equal(intelHits, 1);

    // .pause sentinel exists and carries the exact decisionId from the refusal
    const pausePath = path.join(dir, ".pause");
    const pauseState = checkPauseSwitchFile(pausePath);
    assert.equal(pauseState.paused, true);
    assert.equal(pauseState.decisionId, first.decisionId);
    assert.equal(pauseState.reason, "twzrd_decision_block");

    // Second payment attempt short-circuits on .pause before calling intel
    const second = await twzrdApprovePayment(
      { sellerWallet: SELLER, priceUsdc: 0.05, chain: SOL, asset: USDC },
      {
        intelBase: "https://intel.example",
        fetch: denyFetch,
        preflightMinScore: 40,
        blockDecisions: new Set(["block"]),
        failOpen: false,
        gateOnCanSpend: false,
        refuseUnevaluated: true,
        refuseUncappedWarn: true,
        intelTimeoutMs: 2000,
        refuseWashFlagged: false,
        refuseWashUnknown: false,
        washMaxUsdc: null,
        unsupportedNetworkMode: "observe",
        stateDir: dir,
      },
    );
    assert.equal(second.approved, false);
    assert.match(second.reason, /^twzrd_payment_paused/);
    assert.equal(intelHits, 1, "active .pause must short-circuit before hitting intel");

    // spendControlSafeFetch also honours active .kill and .pause with signerInvocations === 0
    let signerRuns = 0;
    const challengeRes = () =>
      new Response(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: SOL,
              payTo: SELLER,
              maxAmountRequired: "10000",
              asset: USDC,
              resource: "https://merchant.example/api",
            },
          ],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      );

    const safePaused = await spendControlSafeFetch("https://merchant.example/api", {
      stateDir: dir,
      fetch: (async () => challengeRes()) as unknown as typeof fetch,
      pay: async () => {
        signerRuns += 1;
        return { response: new Response("paid", { status: 200 }) };
      },
    });
    assert.equal(safePaused.verdict, "block");
    assert.equal(safePaused.reason, "twzrd_payment_paused");
    assert.equal(safePaused.signerInvocations, 0);
    assert.equal(signerRuns, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
