/**
 * No-spend consumer adjacency demo.
 *
 * 1) Pure router cases (offline).
 * 2) Live free demo-gate: block + signerInvocations === 0 (0 USDC).
 *
 * Run from twzrd-x402-gate/:
 *   npx tsx examples/consumer-adjacency-demo.ts
 */
import assert from "node:assert/strict";

import {
  EVIDENCE_OBJECTS,
  decideSolanaConsumerAction,
  describeEvidenceObject,
  routeConsumer402,
  routeConsumerAccept,
} from "../src/consumer-adjacency.js";

const DEMO_GATE = "https://intel.twzrd.xyz/v1/intel/demo-gate";
const REFUSE_PAYTO = "CnTmHDXVEafkc8sFSzNky9w5zwk63Bk2mHZZodorjhvR";

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  section("offline rail router");
  const sol = routeConsumerAccept({
    network: "solana",
    payTo: REFUSE_PAYTO,
  });
  assert.equal(sol.rail, "solana_twzrd");
  assert.equal(sol.runTwzrdPreflight, true);
  console.log(JSON.stringify(sol, null, 2));

  const stripe = routeConsumerAccept({ method: "stripe", network: "tempo" });
  assert.equal(stripe.rail, "stripe_link");
  assert.equal(stripe.runTwzrdPreflight, false);
  console.log(JSON.stringify(stripe, null, 2));

  const mixed = routeConsumer402({
    accepts: [
      { method: "stripe" },
      { network: "solana", payTo: REFUSE_PAYTO },
    ],
  });
  assert.equal(mixed.primary.rail, "solana_twzrd");
  assert.equal(mixed.note, "run_twzrd_on_solana_accept_only");
  console.log(JSON.stringify(mixed, null, 2));

  const blocked = decideSolanaConsumerAction({
    preflightDecision: "block",
    washFlagged: false,
  });
  assert.equal(blocked.action, "do_not_pay");
  assert.equal(blocked.canSign, false);
  console.log("solana block →", blocked);

  section("evidence objects (distinct — never “the receipt”)");
  for (const kind of EVIDENCE_OBJECTS) {
    console.log(`- ${kind}: ${describeEvidenceObject(kind)}`);
  }

  section("live demo-gate (no wallet, 0 USDC)");
  const res = await fetch(DEMO_GATE, {
    headers: { accept: "application/json", "user-agent": "twzrd-consumer-adjacency-demo/0.1" },
  });
  if (!res.ok) {
    throw new Error(`demo-gate HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    ok?: boolean;
    mode?: string;
    steps?: Array<{
      name?: string;
      verdict?: string;
      approved?: boolean;
      signer_invocations?: number;
    }>;
  };
  const block = body.steps?.find((s) => s.name === "block_path");
  if (!block) {
    throw new Error("demo-gate missing block_path step");
  }
  assert.equal(block.verdict, "block");
  assert.equal(block.approved, false);
  assert.equal(block.signer_invocations, 0);
  assert.equal(body.mode, "no_spend");
  console.log(
    JSON.stringify(
      {
        verdict: block.verdict,
        approved: block.approved,
        signerInvocations: block.signer_invocations,
        mode: body.mode,
        ok: body.ok,
        pins: {
          gate: "twzrd-x402-gate@0.9.6",
          verifier: "twzrd-receipt-verifier@^1.4.0",
        },
      },
      null,
      2,
    ),
  );

  console.log("\nOK consumer-adjacency demo: refuse-before-sign proven, 0 USDC.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
