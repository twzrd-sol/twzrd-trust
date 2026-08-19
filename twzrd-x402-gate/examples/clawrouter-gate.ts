#!/usr/bin/env -S npx tsx
/**
 * Wire the TWZRD preflight gate into a real ClawRouter / BlockRun x402 flow.
 *
 * ClawRouter (`npx @blockrun/clawrouter`) runs a local proxy on :8402 that does
 *   request -> HTTP 402 (accepts[].payTo) -> wallet signs USDC -> retry -> response.
 * We wrap the fetch that talks to that proxy with `wrapFetchWithTwzrdGate`, so the
 * free TWZRD preflight runs on the merchant's payTo BEFORE any USDC is signed.
 * decision=block (or can_spend=false / trust_score<min) -> throw, no payment.
 *
 *   Dry run (no proxy, no USDC; in-process mock :8402 emitting a real x402 402 shape):
 *     npx tsx examples/clawrouter-gate.ts --dry-run
 *     npx tsx examples/clawrouter-gate.ts --dry-run --decision block   # show the block path
 *
 *   Live (real ClawRouter proxy must be up; gate runs before its USDC settle):
 *     npx @blockrun/clawrouter            # in another shell — prints a wallet to fund
 *     npx tsx examples/clawrouter-gate.ts --live --path /v1/surf/market/price?symbol=BTC
 *
 * The gate calls ONLY the free POST /v1/intel/preflight. It never settles, routes, or holds funds.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { wrapFetchWithTwzrdGate, resolveConfig } from "../src/index.js";

type Args = { live: boolean; decision: string; path: string; proxyBase?: string };

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    live: argv.includes("--live"),
    decision: get("--decision") ?? "allow", // dry-run only: which ReadinessCard the mock preflight returns
    path: get("--path") ?? "/v1/surf/market/price?symbol=BTC",
    proxyBase: get("--proxy") ?? process.env.CLAWROUTER_PROXY_BASE,
  };
}

/** In-process stand-in for the ClawRouter :8402 proxy: emits a real x402 402 on a paid path. */
function startMockClawRouter(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        x402Version: 1,
        error: "payment_required",
        accepts: [
          {
            scheme: "exact",
            network: "solana",
            maxAmountRequired: "3000", // 0.003 USDC (6dp) — ClawRouter T1 price
            resource: `https://blockrun.ai${req.url}`,
            payTo: "BLOCKRUN_TREASURY_WALLET_DEMO",
            asset: "USDC",
          },
        ],
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Dry-run preflight: deterministic ReadinessCard so we can show both block + allow paths offline. */
function mockPreflightFetch(decision: string): typeof fetch {
  const card =
    decision === "block"
      ? { decision: "block", trust_score: 12, can_spend: false }
      : { decision: "allow", trust_score: 84, can_spend: true };
  return (async (url: unknown) => {
    if (String(url).includes("/v1/intel/preflight")) {
      return new Response(JSON.stringify({ readiness_card: card }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`=== TWZRD gate -> ClawRouter flow (${args.live ? "LIVE" : "DRY-RUN"}) ===`);

  let proxyBase: string;
  let close: (() => Promise<void>) | undefined;
  let gateConfig;

  if (args.live) {
    proxyBase = args.proxyBase ?? "http://localhost:8402";
    gateConfig = resolveConfig(); // real preflight -> intel.twzrd.xyz, real global fetch
    console.log(`proxy: ${proxyBase} (real ClawRouter). preflight: ${gateConfig.intelBase} (free).`);
  } else {
    const mock = await startMockClawRouter();
    proxyBase = mock.base;
    close = mock.close;
    gateConfig = resolveConfig({ fetch: mockPreflightFetch(args.decision) });
    console.log(`proxy: ${proxyBase} (in-process mock). preflight: mock card decision=${args.decision}.`);
  }

  // THE WIRING: wrap the fetch that calls ClawRouter with the trust gate.
  const gatedFetch = wrapFetchWithTwzrdGate(fetch, gateConfig);

  const url = `${proxyBase}${args.path}`;
  console.log(`\ncalling paid resource via gated fetch:\n  ${url}\n`);

  let exitCode = 0;
  try {
    const resp = await gatedFetch(url);
    // Gate approved -> original 402 returned; the real x402 client now signs USDC + retries.
    console.log(`PASS gate: status=${resp.status} -> ClawRouter would now sign USDC and retry.`);
    if (resp.status === 402) {
      console.log("  (in a real flow @blockrun/clawrouter attaches payment here; gate already cleared the seller)");
    }
  } catch (err) {
    // Gate denied BEFORE any payment was signed — this is the product working.
    console.log(`BLOCKED before pay: ${err instanceof Error ? err.message : String(err)}`);
    console.log("  No USDC was signed. The pay-then-discover-bad pattern was prevented.");
    exitCode = 10; // distinct, non-fatal: a block is a successful gate outcome in the block demo
  } finally {
    if (close) await close();
  }

  console.log("\n=== done ===");
  // In --dry-run --decision block we EXPECT the block; surface it but don't treat as script failure.
  if (!args.live && args.decision === "block") process.exit(0);
  process.exit(exitCode === 10 && !args.live ? 0 : exitCode);
}

main().catch((e) => {
  console.error("clawrouter-gate example error:", e);
  process.exit(1);
});
