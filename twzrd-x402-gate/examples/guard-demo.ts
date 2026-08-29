#!/usr/bin/env tsx
/**
 * withTwzrdGuard demo
 *
 * Demonstrates the TWZRD x402 guard: evaluate any x402 resource before paying,
 * and auto-upsell a paid trust receipt (TWZRD revenue capture) on warn sellers.
 *
 * Usage:
 *   npx tsx examples/guard-demo.ts                       # discover from Agentic.Market
 *   npx tsx examples/guard-demo.ts --target=agentic.market
 *   npx tsx examples/guard-demo.ts <resource-url>        # direct URL
 *
 * Revenue path:
 *   1. Buyer agent wraps fetch with withTwzrdGuard.
 *   2. Agent hits an x402 resource → gets 402 with seller wallet.
 *   3. Guard runs free TWZRD preflight → most Agentic.Market sellers score warn
 *      (unknown to corpus, default trust_score ~45).
 *   4. On warn + autoReceipt=true: guard auto-fetches paid TWZRD trust receipt
 *      via x402Fetch ($0.05 USDC → TWZRD). Fee captured on-chain.
 *   5. Guard returns original 402 → caller pays the resource.
 *
 * For live receipt capture (step 4), set WZRD_X402_FETCH=live and provide
 * a Solana keypair via WZRD_PAYER_KEYPAIR. Without it, step 4 prints the
 * upsell URL and fee amount as a mechanism proof.
 */

import { withTwzrdGuard, evaluate_x402_resource } from "../src/index.js";
import type { X402PaymentRequirements } from "../src/types.js";

const INTEL_BASE = (process.env.TWZRD_INTEL_BASE ?? "https://intel.twzrd.xyz").replace(/\/+$/, "");
const AGENTIC_API = "https://api.agentic.market/v1/services";

const args = process.argv.slice(2);
const targetFlag = args.find((a) => a.startsWith("--target="))?.slice("--target=".length);
const directUrl = args.find((a) => !a.startsWith("--"));

// Built-in named targets for services that need specific HTTP methods/bodies
const NAMED_TARGETS: Record<
  string,
  { name: string; url: string; method: string; body?: string; contentType?: string }
> = {
  exa: {
    name: "Exa (web search, Solana x402)",
    url: "https://api.exa.ai/search",
    method: "POST",
    body: JSON.stringify({ query: "AI agents", numResults: 1 }),
    contentType: "application/json",
  },
  nansen: {
    name: "Nansen (blockchain data)",
    url: "https://api.nansen.ai/token/summary",
    method: "GET",
  },
};


// ── Discovery ─────────────────────────────────────────────────────────────────

// Agentic.Market API response format
type AgenticEndpoint = {
  url?: string;
  method?: string;
  pricing?: { amount?: string; currency?: string; network?: string };
};
type AgenticService = {
  id?: string;
  name?: string;
  networks?: string[];
  endpoints?: AgenticEndpoint[];
};

async function discoverAgenticResource(): Promise<{
  name: string;
  url: string;
  priceUsdc?: number;
} | null> {
  console.log(`  Querying Agentic.Market for x402 services (${AGENTIC_API})...`);
  try {
    const resp = await fetch(AGENTIC_API, {
      headers: { accept: "application/json" },
    });
    if (!resp.ok) {
      console.log(`  Agentic.Market returned HTTP ${resp.status}`);
      return null;
    }
    const raw = (await resp.json()) as { services?: AgenticService[] };
    const services = raw.services ?? [];
    // Prefer a non-templated Solana-network endpoint (TWZRD operates on Solana)
    for (const svc of services) {
      const nets = (svc.networks ?? []).map((n) => n.toLowerCase());
      const hasSolana = nets.includes("solana");
      const eps = svc.endpoints ?? [];
      const candidates = hasSolana
        ? eps.filter((e) => e.pricing?.network?.toLowerCase() === "solana" && e.url && !e.url.includes("{"))
        : eps.filter((e) => e.url && !e.url.includes("{"));
      const ep = candidates[0];
      if (!ep?.url) continue;
      const priceUsdc = parseFloat(ep.pricing?.amount ?? "0") || undefined;
      console.log(`  Found: ${svc.name ?? svc.id} at ${ep.url}`);
      return { name: svc.name ?? svc.id ?? ep.url, url: ep.url, priceUsdc };
    }
    console.log(`  No suitable endpoint found in ${services.length} services`);
    return null;
  } catch (e) {
    console.log(`  Discovery failed: ${(e as Error).message}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== withTwzrdGuard DEMO ===");
  console.log(`Intel:  ${INTEL_BASE}`);

  // 1. Resolve target resource
  let targetUrl: string;
  let targetName: string;
  let targetMethod = "GET";
  let targetBody: string | undefined;
  let targetContentType: string | undefined;

  if (directUrl) {
    targetUrl = directUrl;
    targetName = "direct-url";
    console.log(`\nTarget (direct): ${targetUrl}`);
  } else if (targetFlag && NAMED_TARGETS[targetFlag.toLowerCase()]) {
    const t = NAMED_TARGETS[targetFlag.toLowerCase()];
    targetUrl = t.url;
    targetName = t.name;
    targetMethod = t.method;
    targetBody = t.body;
    targetContentType = t.contentType;
    console.log(`\nTarget (${targetFlag}): ${targetUrl}`);
  } else {
    const useAgentic = targetFlag === "agentic.market" || !targetFlag;
    if (useAgentic) {
      console.log("\n[1/4] Discovering resource from Agentic.Market...");
      const resource = await discoverAgenticResource();
      if (resource) {
        targetUrl = resource.url;
        targetName = resource.name;
      } else {
        // Fallback: TWZRD intel endpoint (x402-gated, guaranteed payTo in accepts body)
        targetUrl = `${INTEL_BASE}/v1/intel/trust/isU3XW1Fc8wobkR1nPL1itv9UaknRbFpTNU2bkYJV6h`;
        targetName = "twzrd-intel (fallback)";
        console.log(`  API unavailable — fallback to TWZRD intel: ${targetUrl}`);
      }
    } else {
      targetUrl = targetFlag!.startsWith("http") ? targetFlag! : `https://${targetFlag}`;
      targetName = targetFlag!;
    }
  }

  console.log(`\nResource: ${targetName}`);
  console.log(`URL:      ${targetUrl}`);

  // 2. Wire up the guard
  console.log("\n[2/4] Wrapping fetch with withTwzrdGuard...");
  let capturedReceipt: unknown = null;
  let capturedTx: string | undefined;

  const guardedFetch = withTwzrdGuard(fetch, {
    failOpen: true,
    gateOnCanSpend: false,
    // autoReceipt is false here so the demo stays wallet-free by default.
    // Set autoReceipt: true and provide x402Fetch: <walletFetch> for live capture.
    autoReceipt: false,
    onReceipt: (receipt, tx) => {
      capturedReceipt = receipt;
      capturedTx = tx;
      console.log(`\n  *** Receipt captured on-chain! tx=${tx ?? "(none)"} ***`);
    },
  });

  // 3. Hit the resource
  console.log(`\n[3/4] Hitting resource (guard intercepting 402 responses)...`);
  let resp: Response;
  try {
    const reqHeaders: Record<string, string> = { accept: "application/json" };
    if (targetContentType) reqHeaders["content-type"] = targetContentType;
    resp = await guardedFetch(targetUrl, {
      method: targetMethod,
      headers: reqHeaders,
      body: targetBody,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("[twzrd-guard] payment blocked")) {
      console.log(`\n  BLOCKED by guard.`);
      console.log(`  ${msg}`);
      console.log("\n  Guard working correctly — payment was not signed for a blocked seller.");
      console.log("\n=== demo complete ===");
      return;
    }
    console.log(`  Request error: ${msg}`);
    console.log("\n=== demo complete ===");
    return;
  }

  console.log(`  HTTP ${resp.status}`);

  // 4. Inspect the result and show the upsell path
  if (resp.status === 402) {
    let payTo: string | undefined;
    let priceUsdc: number | undefined;

    try {
      const body = (await resp.json()) as { accepts?: Record<string, unknown>[] };
      const first = (body.accepts?.[0] ?? {}) as X402PaymentRequirements;
      payTo = first.payTo ?? first.pay_to;
      const amountMicro = first.maxAmountRequired ?? first.amount;
      if (amountMicro) priceUsdc = Number(amountMicro) / 1_000_000;
    } catch {
      // body not parseable — guard already passed this through
    }

    console.log(`\n  402 returned (guard approved seller — caller handles payment)`);
    if (payTo) console.log(`  Seller wallet: ${payTo.slice(0, 12)}...`);
    if (priceUsdc != null) console.log(`  Resource price: $${priceUsdc} USDC`);

    // Show the upsell opportunity
    console.log("\n[4/4] Receipt upsell analysis (TWZRD revenue path):");
    if (payTo) {
      const pf = await fetch(`${INTEL_BASE}/v1/intel/preflight`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          seller_wallet: payTo,
          price_usdc: priceUsdc,
          agent_intent: "guard_demo_upsell_check",
        }),
      });
      if (pf.ok) {
        const pfData = (await pf.json()) as Record<string, unknown>;
        const card = (pfData.readiness_card ?? pfData) as Record<string, unknown>;
        const decision = String(card.decision ?? "warn");
        const score = typeof card.trust_score === "number" ? card.trust_score : null;
        console.log(`  Preflight result: decision=${decision}, trust_score=${score ?? "n/a"}`);

        const receiptUrl = `${INTEL_BASE}/v1/intel/trust/${payTo}`;
        if (decision === "block") {
          console.log(`  Guard BLOCKS this seller — no upsell (blocked sellers earn nothing).`);
        } else {
          console.log(`  Upsell trigger: decision=${decision} (not block)`);
          console.log(`  Receipt URL:    ${receiptUrl}`);
          console.log(`  TWZRD earns:    $0.05 USDC per upsell (on-chain, gas-sponsored)`);
          console.log(`\n  To capture live:`);
          console.log(`    withTwzrdGuard(fetch, { autoReceipt: true, x402Fetch: walletFetch })`);
          console.log(`    // walletFetch = your x402-capable Solana payer`);
          console.log(`    // TWZRD captures $0.05 → receipt returned to agent`);
        }
      } else {
        console.log(`  Preflight returned ${pf.status} — guard uses fail-open (pass through)`);
      }
    } else {
      console.log(`  No seller wallet in 402 body — cannot run upsell for this resource`);
      console.log(`  (Guard requires payTo or pay_to field in x402 accepts[0])`);
    }
  } else if (resp.status === 200) {
    console.log("\n[4/4] Resource returned 200 — no x402 gate (guard passed through).");
  } else {
    console.log(`\n[4/4] Resource returned ${resp.status} — guard passed through.`);
  }

  if (capturedReceipt) {
    console.log("\n=== RECEIPT CAPTURED ===");
    console.log(`tx:      ${capturedTx ?? "(no tx hash)"}`);
    console.log(`receipt: ${JSON.stringify(capturedReceipt, null, 2)}`);
  }

  console.log("\n=== demo complete ===");
  console.log("withTwzrdGuard is ready to embed in Eliza/GOAT agents.");
  console.log("For live receipt capture: provide x402Fetch + set autoReceipt: true.");
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
