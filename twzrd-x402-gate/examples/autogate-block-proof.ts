#!/usr/bin/env -S npx tsx
/**
 * Canonical AutoGate intercept proof — wash_flagged seller never reaches signer.
 *
 * Uses installTwzrdAutoGate on a minimal x402Client-like surface, live intel
 * preflight + merchant_card, and emits block-proof-<run_id>.json.
 *
 * Does NOT spend USDC. Does NOT require a funded wallet.
 *
 * Run from package root:
 *   npm run autogate-block-proof
 *   npx tsx examples/autogate-block-proof.ts
 *
 * Env:
 *   TWZRD_INTEL_BASE   default https://intel.twzrd.xyz
 *   WASH_PAYTO         wash_flagged fixture override (re-verified live)
 *   BLOCK_PAYTO        decision=block fallback override (re-verified live)
 *   RUN_ID             optional run id
 *   PROOF_OUT_DIR      default cwd
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { installTwzrdAutoGate, uninstallTwzrdAutoGate } from "../src/auto-gate.js";
import {
  buildAutogateBlockProof,
  type AutogateBlockProof,
} from "../src/block-proof.js";
import { CLIENT_VERSION } from "../src/version.js";
import { TWZRD_TRUST_GATE_BLOCK_WASH } from "../src/trust-gate-reason.js";
import type {
  BeforePaymentCreationContext,
  X402ClientLike,
} from "../src/x402-client-hook.js";
import { resolveBlockedSeller } from "./blocked-fixture.js";

const INTEL = (process.env.TWZRD_INTEL_BASE || "https://intel.twzrd.xyz").replace(
  /\/+$/,
  "",
);
const RUN_ID =
  process.env.RUN_ID?.trim() ||
  `autogate-block-${Math.floor(Date.now() / 1000)}`;
const OUT_DIR = process.env.PROOF_OUT_DIR?.trim() || process.cwd();

function makeClient(): {
  client: X402ClientLike;
  fire: (
    ctx: BeforePaymentCreationContext,
  ) => Promise<void | { abort: true; reason: string }>;
} {
  let hook:
    | ((
        ctx: BeforePaymentCreationContext,
      ) => Promise<void | { abort: true; reason: string }>)
    | undefined;
  const client: X402ClientLike = {
    onBeforePaymentCreation(h) {
      hook = h;
      return client;
    },
  };
  return {
    client,
    async fire(ctx) {
      if (!hook) throw new Error("hook not installed");
      return hook(ctx);
    },
  };
}

async function main() {
  // Live fixture: prefer a wash_flagged seller; when the wash overlay drifts,
  // fall back to a live decision=block seller (same refuse seat, different basis).
  const { seller: WASH, basis } = await resolveBlockedSeller(INTEL);

  let signerInvocations = 0;

  const { client, fire } = makeClient();
  let lastDecision: {
    approved: boolean;
    reason: string;
    verdict: string;
  } | null = null;

  installTwzrdAutoGate(client, {
    refuseWashFlagged: true,
    gateOnCanSpend: false,
    preflightMinScore: 0,
    failOpen: true,
    intelBase: INTEL,
    onDecision: (d) => {
      lastDecision = {
        approved: d.approved,
        reason: d.reason,
        verdict: d.verdict,
      };
    },
  });

  // Simulate selected 402 requirements for a wash-flagged payTo (official Path E).
  // Proceed (void) would be the only path that could reach a signer — we never call one.
  const result = await fire({
    selectedRequirements: {
      payTo: WASH,
      network: "solana:mainnet",
      maxAmountRequired: "50000", // 0.05 USDC micro
      resource: `${INTEL}/v1/intel/trust/${WASH}`,
      scheme: "exact",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
  });

  // Invariant: if hook failed to abort, a real client would sign — count a would-be invoke.
  if (result === undefined) {
    signerInvocations += 1;
  }

  const aborted = !!(result && result.abort === true);
  const internalReason = result && "reason" in result ? result.reason : lastDecision?.reason ?? null;

  // Enrich from live merchant_card for transcript (best-effort)
  let washFlagged: boolean | null = null;
  let trustScore: number | null = null;
  let decision: string | null = lastDecision?.verdict ?? null;
  try {
    const mc = await fetch(`${INTEL}/v1/intel/merchant_card/${WASH}`);
    if (mc.ok) {
      const j = (await mc.json()) as { wash_flagged?: boolean; trust_score?: number };
      if (typeof j.wash_flagged === "boolean") washFlagged = j.wash_flagged;
      if (typeof j.trust_score === "number") trustScore = j.trust_score;
    }
  } catch {
    /* ignore */
  }
  try {
    const pf = await fetch(`${INTEL}/v1/intel/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seller_wallet: WASH,
        price_usdc: 0.05,
        agent_intent: "autogate_block_proof",
      }),
    });
    if (pf.ok) {
      const j = (await pf.json()) as {
        readiness_card?: { decision?: string; trust_score?: number };
      };
      const card = j.readiness_card;
      if (card?.decision) decision = card.decision;
      if (typeof card?.trust_score === "number") trustScore = card.trust_score;
    }
  } catch {
    /* ignore */
  }

  const proof: AutogateBlockProof = buildAutogateBlockProof({
    run_id: RUN_ID,
    target_seller: WASH,
    aborted,
    internal_reason: internalReason,
    decision,
    wash_flagged: washFlagged,
    trust_score: trustScore,
    signer_invocations: signerInvocations,
    actual_spend_usdc: 0,
    onchain_settlements: 0,
    package_version: CLIENT_VERSION,
  });

  const outPath = join(OUT_DIR, `block-proof-${RUN_ID}.json`);
  writeFileSync(outPath, JSON.stringify(proof, null, 2) + "\n");

  uninstallTwzrdAutoGate(client);

  console.log(
    JSON.stringify(
      {
        ok: proof.verified,
        out: outPath,
        aborted,
        reason: proof.interception.reason,
        fixture_basis: basis,
        expected:
          basis === "wash_flagged" ? TWZRD_TRUST_GATE_BLOCK_WASH : "twzrd_decision_block",
        signer_invocations: signerInvocations,
        wash_flagged: washFlagged,
        package_version: CLIENT_VERSION,
      },
      null,
      2,
    ),
  );

  if (!proof.verified) {
    console.error(
      "PROOF FAILED: expected abort with 0 signer invocations and 0 spend",
    );
    process.exit(1);
  }
  if (
    basis === "wash_flagged" &&
    proof.interception.reason !== TWZRD_TRUST_GATE_BLOCK_WASH &&
    washFlagged
  ) {
    console.error(
      `WARN: public reason ${proof.interception.reason} (internal=${internalReason})`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
