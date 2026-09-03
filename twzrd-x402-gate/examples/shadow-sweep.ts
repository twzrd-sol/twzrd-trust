/**
 * shadow-sweep.ts — log-only TWZRD trust-gate shadow harness.
 *
 * Purpose
 * -------
 * Demonstrate that a paid agent can wire TWZRD trust into its x402 spend path
 * in THREE different integration surfaces, running entirely in **shadow mode**:
 * every surface calls the FREE preflight (https://intel.twzrd.xyz/v1/intel/preflight),
 * logs the verdict it WOULD enforce, and then lets the original flow proceed
 * untouched. Nothing is signed, no USDC moves, the paid /v1/intel/trust leg is
 * never called. This is the zero-cost "try before you enforce" drop-in.
 *
 *   Surface 1 — buyer pre-sign gate   (twzrd-x402-gate  → twzrdApprovePayment)
 *   Surface 2 — buyer one-liner gate  (plugin-trustgate → checkTrust)
 *   Surface 3 — facilitator settle hook (plugin-trustgate/facilitator → onBeforeSettle)
 *
 * Each surface emits a structured JSONL evidence line so an operator can diff
 * "what the gate would have done" against real settlement logs before flipping
 * enforcement on. Shadow integrations are the on-ramp: observe first, enforce
 * once the verdicts line up with reality.
 *
 * Run
 * ---
 *   tsx examples/shadow-sweep.ts                        (from the package root)
 *   tsx examples/shadow-sweep.ts <wallet> [<wallet> ...]
 *
 * Published-package equivalents (what an external integrator imports):
 *   import { twzrdApprovePayment }        from "twzrd-x402-gate";
 *   import { checkTrust }                 from "@wzrd_sol/plugin-trustgate";
 *   import { createOnBeforeSettleHook }   from "@wzrd_sol/plugin-trustgate/facilitator";
 *
 * This local copy imports the package SOURCE directly so it runs with zero
 * `npm install` (both packages are dependency-free TypeScript).
 */

import { twzrdApprovePayment } from "../src/index.js";
import { checkTrust } from "../../plugin-trustgate/src/gate.js";
import { createOnBeforeSettleHook } from "../../plugin-trustgate/src/facilitator.js";

const INTEL_BASE = process.env.TWZRD_INTEL_BASE ?? "https://intel.twzrd.xyz";

// Default representative sellers — real Solana wallets so the live preflight
// returns real decisions. Override by passing wallets as CLI args.
const DEFAULT_SELLERS = [
  "BJGdsDXJ8mPMr8Lp9kZ6jixYg5d6Fr7tHHKqkmZ8K8aA", // high-volume x402 payer
];

type Evidence = {
  ts: string;
  surface: "buyer_pre_sign" | "buyer_one_liner" | "facilitator_settle";
  seller: string;
  decision: string;
  trust_score: number | null;
  would_block: boolean;
  reason: string;
  gate_available: boolean;
  mode: "shadow";
};

const evidence: Evidence[] = [];

function record(e: Omit<Evidence, "ts" | "mode">): void {
  const line: Evidence = { ts: new Date().toISOString(), mode: "shadow", ...e };
  evidence.push(line);
  // JSONL evidence line — pipe to a file or your log aggregator.
  console.log(JSON.stringify(line));
}

/**
 * Surface 1 — buyer pre-sign gate.
 * The richest buyer path: score the seller + resource context before signing.
 * Shadow: we read `approved` but DO NOT abort — we only log what we'd enforce.
 */
async function shadowBuyerPreSign(seller: string): Promise<void> {
  const result = await twzrdApprovePayment(
    {
      sellerWallet: seller,
      payTo: seller,
      resourceName: "shadow_demo_resource",
      priceUsdc: 0.05,
      agentIntent: "shadow_sweep_observe_only",
    },
    // failOpen omitted -> fail-closed; in shadow we still just log the verdict.
    undefined,
  );
  record({
    surface: "buyer_pre_sign",
    seller,
    decision: result.verdict ?? "unknown",
    trust_score: result.score ?? null,
    would_block: !result.approved,
    reason: result.reason,
    gate_available: result.failOpen === undefined ? true : !result.failOpen,
  });
}

/**
 * Surface 2 — buyer one-liner gate.
 * The minimal drop-in for elizaOS / agent action code. `checkTrust` never throws.
 */
async function shadowBuyerOneLiner(seller: string): Promise<void> {
  const v = await checkTrust(seller, { intelBase: INTEL_BASE });
  record({
    surface: "buyer_one_liner",
    seller,
    decision: v.decision,
    trust_score: v.trustScore,
    would_block: v.blocked,
    reason: v.reason,
    gate_available: v.gateAvailable,
  });
}

/**
 * Surface 3 — facilitator settle hook.
 * "Be in the settle path": the hook screens every brokered settlement. We build
 * the real hook with an `onVerdict` observer and feed it a structural settle
 * context, then DISCARD its abort return (shadow). In production you'd return it.
 */
async function shadowFacilitatorSettle(seller: string): Promise<void> {
  let captured: { decision: string; trustScore: number | null; blocked: boolean; reason: string; gateAvailable: boolean } | null = null;
  const hook = createOnBeforeSettleHook({
    intelBase: INTEL_BASE,
    onVerdict: (verdict) => {
      captured = {
        decision: verdict.decision,
        trustScore: verdict.trustScore,
        blocked: verdict.blocked,
        reason: verdict.reason,
        gateAvailable: verdict.gateAvailable,
      };
    },
  });
  const abort = await hook({
    requirements: {
      payTo: seller,
      // CAIP-2 Solana mainnet so the Solana-only gate engages.
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: "USDC",
      amount: "50000",
    },
  });
  if (captured) {
    const c = captured as NonNullable<typeof captured>;
    record({
      surface: "facilitator_settle",
      seller,
      decision: c.decision,
      trust_score: c.trustScore,
      would_block: c.blocked,
      reason: c.reason,
      gate_available: c.gateAvailable,
    });
  } else {
    // No verdict captured => non-Solana or skipped. Record the abort shape.
    record({
      surface: "facilitator_settle",
      seller,
      decision: abort ? "block" : "allow",
      trust_score: null,
      would_block: Boolean(abort),
      reason: abort ? abort.reason : "no_verdict_skipped",
      gate_available: false,
    });
  }
}

async function main(): Promise<void> {
  const sellers = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SELLERS;

  console.error(`# TWZRD shadow sweep — intelBase=${INTEL_BASE} — ${sellers.length} seller(s) × 3 surfaces (log-only, free preflight, no spend)`);

  for (const seller of sellers) {
    await shadowBuyerPreSign(seller);
    await shadowBuyerOneLiner(seller);
    await shadowFacilitatorSettle(seller);
  }

  // Summary to stderr so stdout stays clean JSONL.
  const wouldBlock = evidence.filter((e) => e.would_block).length;
  const surfaces = new Set(evidence.map((e) => e.surface)).size;
  console.error("");
  console.error(`# shadow sweep complete: ${evidence.length} evidence lines across ${surfaces} integration surface(s)`);
  console.error(`#   would-block: ${wouldBlock} / ${evidence.length}   (shadow mode — nothing was actually blocked or spent)`);
  console.error(`# Next: diff these verdicts against your settlement logs; flip enforcement on once they agree.`);
}

main().catch((err) => {
  console.error("[shadow-sweep] fatal:", err);
  process.exit(1);
});
