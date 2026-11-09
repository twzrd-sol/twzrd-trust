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
import { installTwzrdAutoGate } from "../src/auto-gate.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import { createTwzrdMppOnChallenge, type MppChallenge } from "../src/mpp-hook.js";
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

test("Lock 1: parseBindingPolicy validates only the payment domain by default and isolates compute errors", () => {
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
  // Default call (no options) ignores compute section typos (Lock 1).
  const paymentDefault = parseBindingPolicy({
    schema: "twzrd.binding_policy.v1",
    compute: { bad_compute_key: -1 } as unknown as Record<string, unknown>,
    payment: { max_spend_usdc: "0.10" },
  });
  assert.equal(paymentDefault.payment?.max_spend_usdc, "0.10");
  assert.equal(paymentDefault.compute, undefined);
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

test("Hole 5: tripPauseOnBlockMs is opt-in; when set, a fatal refusal writes .pause with that TTL and a non-fatal refusal does not", async () => {
  const dir = tmpDir();
  try {
    const pausePath = path.join(dir, ".pause");

    // 1. Non-fatal refusal (transient preflight outage) must NOT write .pause, even when the trip is switched on
    const outage = await twzrdApprovePayment(
      { sellerWallet: SELLER, priceUsdc: 0.05, chain: SOL, asset: USDC },
      {
        intelBase: "https://intel.example",
        fetch: (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
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
    assert.equal(outage.approved, false);
    assert.match(outage.reason, /^twzrd_fail_closed/);
    assert.equal(fs.existsSync(pausePath), false, "non-fatal outage must not write .pause");

    // 2. Fatal refusal (twzrd_decision_block) with tripPauseOnBlockMs omitted: refused, and no sentinel is written
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

    const gateConfig = {
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
      unsupportedNetworkMode: "observe" as const,
      stateDir: dir,
    };
    const unarmed = await twzrdApprovePayment(
      { sellerWallet: SELLER, priceUsdc: 0.05, chain: SOL, asset: USDC },
      gateConfig,
    );
    assert.equal(unarmed.approved, false);
    assert.equal(unarmed.reason, "twzrd_decision_block");
    assert.equal(intelHits, 1);
    assert.equal(fs.existsSync(pausePath), false, "tripPauseOnBlockMs is off unless the caller sets it");

    // 3. The same fatal refusal with the trip switched on writes .pause with the caller's TTL
    const beforeMs = Date.now();
    const first = await twzrdApprovePayment(
      { sellerWallet: SELLER, priceUsdc: 0.05, chain: SOL, asset: USDC },
      { ...gateConfig, tripPauseOnBlockMs: 60_000 },
    );
    const afterMs = Date.now();
    assert.equal(first.approved, false);
    assert.equal(first.reason, "twzrd_decision_block");
    assert.equal(intelHits, 2);

    const pauseState = checkPauseSwitchFile(pausePath);
    assert.equal(pauseState.paused, true);
    assert.equal(pauseState.decisionId, first.decisionId);
    assert.equal(pauseState.reason, "twzrd_decision_block");
    assert.ok(
      pauseState.untilUnixMs! >= beforeMs + 60_000 && pauseState.untilUnixMs! <= afterMs + 60_000,
      ".pause expiry is the caller's TTL, not a built-in window",
    );
    assert.equal(fs.existsSync(path.join(dir, ".kill")), false, "a block trip never writes .kill");

    // 4. Subsequent calls short-circuit on .pause before hitting intel
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
    assert.equal(intelHits, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Hole 1: MPP hook honours .kill and .pause sentinels before creating any payment credential", async () => {
  const dir = tmpDir();
  try {
    const challenge: MppChallenge = {
      id: "chal_mpp_sentinel_1",
      realm: "merchant.example",
      method: "solana",
      intent: "charge",
      request: {
        amount: "10000",
        currency: USDC,
        decimals: 6,
        recipient: SELLER,
      },
    };
    const decisionFile = path.join(dir, "decisions.jsonl");

    // 1. With .kill present in stateDir, createTwzrdMppOnChallenge refuses before createCredential()
    fs.writeFileSync(path.join(dir, ".kill"), "killed\n");
    let credCalls = 0;
    const onChallenge = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      stateDir: dir,
      decisionFile,
      intelligence: () => ({ counterpartyKnown: true, washFlagged: false }),
    });

    await assert.rejects(
      () =>
        onChallenge(challenge, {
          createCredential: async () => {
            credCalls += 1;
            return "cred_should_not_exist";
          },
        }),
      /twzrd_kill_switch/,
    );
    assert.equal(credCalls, 0, "MPP hook must not create a credential when .kill is present");
    fs.unlinkSync(path.join(dir, ".kill"));

    // 2. With active .pause present (via TWZRD_STATE_DIR env + installTwzrdAutoGate('mpp')), refuses before createCredential()
    writePauseSentinel(path.join(dir, ".pause"), {
      ttlMs: 60_000,
      reason: "budget_exceeded",
      decisionId: "dec_ks_cap_1",
    });
    process.env.TWZRD_STATE_DIR = dir;
    try {
      const autoMppHook = installTwzrdAutoGate("mpp", {
        signer: createLocalDecisionSigner(),
        decisionFile,
        intelligence: () => ({ counterpartyKnown: true, washFlagged: false }),
      }) as (c: MppChallenge, h: { createCredential: () => Promise<string> }) => Promise<string | undefined>;

      await assert.rejects(
        () =>
          autoMppHook(challenge, {
            createCredential: async () => {
              credCalls += 1;
              return "cred_should_not_exist";
            },
          }),
        /twzrd_payment_paused/,
      );
      assert.equal(credCalls, 0, "MPP auto-gate seat must not create a credential when .pause is active");
    } finally {
      delete process.env.TWZRD_STATE_DIR;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
