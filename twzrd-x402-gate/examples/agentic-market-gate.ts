#!/usr/bin/env -S npx tsx
/**
 * TWZRD guard -> Agentic.Market x402 resource demo.
 *
 * Shows the full guard → warn → upsell flow. In dry-run mode the preflight is
 * mocked so no network call or funded wallet is required.
 *
 * Usage:
 *   npx tsx examples/agentic-market-gate.ts --dry-run
 *   npx tsx examples/agentic-market-gate.ts --seller JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
 */
import { withTwzrdGuard } from "../src/index.js";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((v, i, a) =>
    v.startsWith("--") ? [[v.slice(2), a[i + 1] ?? true]] : [],
  ),
);

const DEMO_SELLER =
  typeof args.seller === "string"
    ? args.seller
    : "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const DEMO_RESOURCE =
  typeof args.resource === "string"
    ? args.resource
    : "https://agentic.market/api/price";

const isDryRun = args["dry-run"] === true || args["dry-run"] === "true";

/**
 * Simulated resource call — in a real integration, use an x402-capable fetch
 * (e.g. AgentCash or @x402/fetch) that handles the 402 challenge automatically.
 */
async function callAgenticMarket(sellerWallet: string) {
  if (isDryRun) {
    return { mock: true, sellerWallet, status: "would_call_resource" };
  }
  const resp = await fetch(DEMO_RESOURCE);
  if (resp.status === 402) {
    const body = await resp.json();
    return { status: 402, accepts: body.accepts };
  }
  return resp.json();
}

async function main() {
  console.log(`=== TWZRD guard -> Agentic.Market ===`);
  console.log(`Seller:   ${DEMO_SELLER}`);
  console.log(`Resource: ${DEMO_RESOURCE}`);
  console.log(`Mode:     ${isDryRun ? "dry-run (mocked preflight)" : "live"}`);
  console.log("");

  const mockFetch = isDryRun
    ? (async (url: unknown) => {
        const u = String(url);
        if (u.includes("/v1/intel/preflight")) {
          return new Response(
            JSON.stringify({
              readiness_card: {
                decision: "warn",
                trust_score: 45,
                can_spend: false,
                full_report_price_usdc: 0.05,
                paid_trust_endpoint: `/v1/intel/trust/${DEMO_SELLER}`,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 402 });
      }) as unknown as typeof fetch
    : undefined;

  const guard = withTwzrdGuard(callAgenticMarket, {
    ...(mockFetch ? { fetch: mockFetch } : {}),
    // Gate only on explicit block-rated sellers; warn passes through
    gateOnCanSpend: false,
    onWarnUpsell: (ctx) => {
      console.log(
        `[upsell] warn seller ${ctx.sellerWallet ?? "unknown"} — ` +
          `get receipt: https://intel.twzrd.xyz${ctx.upsellUrl} ($${ctx.priceUsdc} USDC)`,
      );
    },
  });

  try {
    const result = await guard(DEMO_SELLER);
    console.log("Gate approved. Resource responded:", result);
  } catch (e) {
    console.log("Gate blocked:", e instanceof Error ? e.message : e);
    console.log("No payment was made.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
