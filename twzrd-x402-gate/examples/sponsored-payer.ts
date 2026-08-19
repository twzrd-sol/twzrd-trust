#!/usr/bin/env -S npx tsx
/**
 * SPONSORED PAYER (prototype): use the paid rungs with NO wallet of your own.
 *
 * The paid rungs (quickCheck $0.001, autoReceipt $0.05) need an x402Fetch that
 * settles USDC. `createSponsoredX402Fetch` lets a SPONSOR settle on the agent's
 * behalf — you pass the result straight into quickCheck/autoReceipt.
 *
 * Two backends plug into `settle`:
 *   1. GAS-SPONSORED (live via @x402/svm): agent pays USDC, resource server's
 *      feePayer covers SOL gas. settle = the agent's @x402/svm ExactSvmScheme fetch.
 *   2. FULL-SPONSOR (no wallet): settle = POST to a TWZRD treasury sponsor endpoint
 *      that pays on the agent's behalf. That endpoint + treasury is FOUNDER-GATED
 *      (who funds it + per-agent budget caps). This demo dry-runs the client seam.
 *
 * Run (no spend, mocked):  npx tsx examples/sponsored-payer.ts --dry-run
 */
import { createSponsoredX402Fetch, quickCheck } from "../src/index.js";

const DRY_RUN = process.argv.includes("--dry-run") || !process.env.TWZRD_X402_LIVE;
const SELLER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

async function main() {
  if (!DRY_RUN) {
    console.error("Refusing to run live without a real sponsor `settle`. Use --dry-run, or wire a backend (see header).");
    process.exit(1);
  }

  // A no-wallet integrator: no Solana key, no x402 client. The sponsor settles.
  // In dry-run we mock the sponsor's response; in production `settle` is the agent's
  // @x402/svm fetch (gas-sponsored) or a TWZRD treasury sponsor-endpoint fetch.
  const x402Fetch = createSponsoredX402Fetch({
    dryRun: true,
    dryRunBody: { pubkey: SELLER, tier: "Gold", score: 120, paid: true, charged_amount_usdc: 0.001 },
    onSettle: (url) => console.log(`   [sponsor] (dry-run) would settle on agent's behalf -> ${url}`),
  });

  console.log("== No-wallet integrator -> quickCheck via the sponsor ==");
  const q = await quickCheck(SELLER, { x402Fetch });
  console.log(`   available=${q.available} tier=${q.tier} score=${q.score} (no wallet held by the caller)`);

  console.log("\nDone (dry-run — the sponsor settled nothing on-chain).");
  console.log("Production: pass `settle` = your @x402/svm fetch, or a TWZRD treasury");
  console.log("sponsor-endpoint fetch (founder-gated). The seam is identical.");
}

/*
 * ── PRODUCTION WIRING (gas-sponsored, live model) ──────────────────────────
 * import { x402Client } from "@x402/core/client";
 * import { ExactSvmScheme } from "@x402/svm";
 * const scheme = new ExactSvmScheme(agentSigner, { rpcUrl });   // agent signs USDC
 * const settle = (url, init) => x402Client(scheme).fetch(url, init); // feePayer = sponsored
 * const x402Fetch = createSponsoredX402Fetch({ settle });
 *
 * ── FULL-SPONSOR (no-wallet, founder-gated) ────────────────────────────────
 * const settle = (url) => fetch(TWZRD_SPONSOR_URL, {
 *   method: "POST", headers: { authorization: `Bearer ${apiKey}` },
 *   body: JSON.stringify({ target: url }),     // treasury pays on the agent's behalf
 * });
 * const x402Fetch = createSponsoredX402Fetch({ settle });
 */
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
