/**
 * Real-runtime proof that twzrdOnPaymentRequested blocks BEFORE the Solana
 * signer is invoked, and settles when allowed, inside the ACTUAL @x402/mcp
 * runtime (x402MCPClient + x402ResourceServer + createPaymentWrapper), not a
 * mocked request shape.
 *
 * Topology: real @modelcontextprotocol/sdk client<->server over an in-memory
 * transport; the payment rails are REAL - the gate calls TWZRD's production
 * preflight (https://intel.twzrd.xyz), and the settle phase signs with a real
 * funded mainnet wallet and settles USDC via the public PayAI facilitator
 * (the same facilitator TWZRD's own intel server lists in accepts[1]).
 *
 * Phases:
 *   block  - FREE. Paid tool priced $0.001 payTo the x402helper.xyz shared
 *            wallet (live preflight: decision:warn, can_spend:false). Gate
 *            config gateOnCanSpend:true => hook must return false, callTool
 *            must fail 402, and the instrumented signer must record ZERO calls.
 *   settle - SPENDS $0.001 USDC on Solana mainnet (requires
 *            TWZRD_E2E_CONFIRM_SPEND=1). Paid tool payTo TWZRD's live intel
 *            seller wallet; default gate policy approves (warn 53.9 >= 40).
 *            Asserts hook fired BEFORE the first signer call, exactly one
 *            settle, then independently verifies the returned tx signature
 *            against a public RPC (not trusting the client library).
 *
 * Run from packages/twzrd-x402-gate/e2e:
 *   npm run proof:block
 *   TWZRD_E2E_CONFIRM_SPEND=1 npm run proof:settle
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createKeyPairSignerFromBytes, type TransactionSigner } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { createPaymentWrapper, wrapMCPClientWithPayment } from "@x402/mcp";
import { registerExactSvmScheme as registerSvmClientScheme } from "@x402/svm/exact/client";
import { registerExactSvmScheme as registerSvmServerScheme } from "@x402/svm/exact/server";
import { z } from "zod";

import { resolveConfig } from "../src/config.js";
import { assertNotHousePayerKey } from "../src/foreign-key.js";
import { twzrdOnPaymentRequested } from "../src/mcp-hook.js";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYAI_FACILITATOR = "https://facilitator.payai.network";
const PUBLIC_RPC = process.env.TWZRD_E2E_RPC ?? "https://api.mainnet-beta.solana.com";

/** x402helper.xyz shared test wallet - live preflight: warn / 56.8 / can_spend:false */
const BLOCK_PAYTO = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
/** TWZRD's live intel seller wallet (payTo on intel.twzrd.xyz's own 402) */
const SETTLE_PAYTO = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
/** Price for both tools: $0.001 (1000 micro-USDC). HARD CAP guard below. */
const PRICE = "$0.001";
const PRICE_MICRO_MAX = 10_000; // $0.01 - abort if requirements ever exceed this

const KEYPAIR_PATH =
  process.env.TWZRD_E2E_PAYER_KEYPAIR ??
  join(homedir(), ".config", "solana", "external-test-payer.json");

type Timeline = { hookAt: number[]; signAt: number[]; hookResults: boolean[] };

function instrumentSigner(inner: TransactionSigner, tl: Timeline): TransactionSigner {
  // KeyPairSigner objects from @solana/kit are frozen (Proxy get traps violate
  // JS invariants on them), so build a plain wrapper exposing the same signer
  // interface with counting shims around every signing method.
  const anyInner = inner as unknown as Record<string, unknown>;
  const wrapped: Record<string, unknown> = {};
  for (const key of Object.keys(anyInner)) {
    const v = anyInner[key];
    if (
      typeof v === "function" &&
      (key === "signTransactions" || key === "modifyAndSignTransactions" || key === "signMessages")
    ) {
      wrapped[key] = (...args: unknown[]) => {
        tl.signAt.push(Date.now());
        return (v as (...a: unknown[]) => unknown).apply(inner, args);
      };
    } else {
      wrapped[key] = v;
    }
  }
  return wrapped as unknown as TransactionSigner;
}

async function buildHarness(opts: {
  payTo: string;
  gateConfig: ReturnType<typeof resolveConfig>;
  tl: Timeline;
}) {
  // ---- server side: real x402ResourceServer + PayAI facilitator ----
  const facilitator = new HTTPFacilitatorClient({ url: PAYAI_FACILITATOR });
  const rs = new x402ResourceServer(facilitator);
  registerSvmServerScheme(rs);
  await (rs as unknown as { initialize: () => Promise<void> }).initialize();
  const accepts = await rs.buildPaymentRequirements({
    scheme: "exact",
    network: SOLANA_MAINNET,
    payTo: opts.payTo,
    price: PRICE,
  });
  assert.ok(accepts.length > 0, "resource server built payment requirements");
  for (const req of accepts) {
    const amt = Number((req as { amount?: string; maxAmountRequired?: string }).amount ?? (req as { maxAmountRequired?: string }).maxAmountRequired);
    assert.ok(
      Number.isFinite(amt) && amt > 0 && amt <= PRICE_MICRO_MAX,
      `spend guard: requirement amount ${amt} within $0.01 cap`,
    );
    assert.equal((req as { asset?: string }).asset, USDC_MINT, "asset is mainnet USDC");
  }

  const server = new McpServer({ name: "twzrd-e2e-paid-server", version: "0.0.1" });
  const paid = createPaymentWrapper(rs, { accepts });
  server.tool(
    "intel_probe",
    `paid probe (${PRICE})`,
    { q: z.string() },
    paid(async (args: { q: string }) => ({
      content: [{ type: "text" as const, text: `paid-ok:${args.q}` }],
    })),
  );

  // ---- client side: real signer (instrumented) + real @x402/mcp client ----
  assertNotHousePayerKey(KEYPAIR_PATH);
  const secret = new Uint8Array(JSON.parse(readFileSync(KEYPAIR_PATH, "utf8")));
  const kp = await createKeyPairSignerFromBytes(secret);
  const signer = instrumentSigner(kp, opts.tl);

  const paymentClient = new x402Client();
  registerSvmClientScheme(paymentClient, { signer });

  const mcp = new Client({ name: "twzrd-e2e-agent", version: "0.0.1" });
  const x402mcp = wrapMCPClientWithPayment(mcp, paymentClient, {
    autoPayment: true,
    onPaymentRequested: async (ctx) => {
      opts.tl.hookAt.push(Date.now());
      const allowed = await twzrdOnPaymentRequested(ctx, opts.gateConfig);
      opts.tl.hookResults.push(allowed);
      console.log(
        `[hook] onPaymentRequested tool=${ctx.toolName} accepts[0].payTo=${(ctx.paymentRequired?.accepts?.[0] as { payTo?: string } | undefined)?.payTo} -> ${allowed ? "ALLOW" : "DENY"}`,
      );
      return allowed;
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await x402mcp.connect(clientTransport);
  return { x402mcp, payerAddress: kp.address as string };
}

async function phaseBlock() {
  console.log("=== PHASE: block (free - no signing, no spend) ===");
  const tl: Timeline = { hookAt: [], signAt: [], hookResults: [] };
  // Strict policy: x402helper wallet is warn/can_spend:false live -> deny.
  const gateConfig = resolveConfig({ gateOnCanSpend: true });
  const { x402mcp } = await buildHarness({ payTo: BLOCK_PAYTO, gateConfig, tl });

  let failed: unknown = null;
  try {
    const res = await x402mcp.callTool("intel_probe", { q: "block-test" });
    failed = res?.isError ? new Error("tool returned isError") : null;
    if (!failed) console.log("UNEXPECTED SUCCESS:", JSON.stringify(res).slice(0, 400));
  } catch (e) {
    failed = e;
  }

  assert.ok(failed, "callTool must fail when the gate denies");
  assert.equal(tl.hookAt.length >= 1, true, "hook was invoked");
  assert.deepEqual(tl.hookResults, [false], "hook denied exactly once");
  assert.equal(tl.signAt.length, 0, "signer was NEVER invoked (blocked before sign)");
  console.log(
    `BLOCK PROOF PASS: hook denied payTo=${BLOCK_PAYTO} via live preflight; signer calls=0; error=${String((failed as Error)?.message ?? failed).slice(0, 160)}`,
  );
}

async function phaseSettle() {
  console.log("=== PHASE: settle (REAL $0.001 USDC on Solana mainnet) ===");
  assert.equal(
    process.env.TWZRD_E2E_CONFIRM_SPEND,
    "1",
    "settle phase spends real USDC - set TWZRD_E2E_CONFIRM_SPEND=1 to proceed",
  );
  const tl: Timeline = { hookAt: [], signAt: [], hookResults: [] };
  // Default policy: TWZRD's own seller wallet scores warn/53.9 live (the free
  // preflight is down-only and never emits `allow`), which clears min score 40.
  const gateConfig = resolveConfig({});
  const { x402mcp, payerAddress } = await buildHarness({ payTo: SETTLE_PAYTO, gateConfig, tl });
  console.log(`payer=${payerAddress} payTo=${SETTLE_PAYTO} price=${PRICE}`);

  const res = await x402mcp.callTool("intel_probe", { q: "settle-test" });
  console.log("tool result:", JSON.stringify({ content: res.content, isError: res.isError, paymentMade: res.paymentMade }).slice(0, 300));
  assert.ok(!res.isError, "paid tool call succeeded");
  assert.equal(res.paymentMade, true, "payment was made");
  assert.deepEqual(tl.hookResults, [true], "hook allowed exactly once");
  assert.ok(tl.signAt.length >= 1, "signer was invoked for the allowed payment");
  assert.ok(
    tl.hookAt[0] < tl.signAt[0],
    `hook (${tl.hookAt[0]}) ran BEFORE first signer call (${tl.signAt[0]})`,
  );

  const settle = res.paymentResponse as { success?: boolean; transaction?: string; payer?: string; network?: string } | undefined;
  assert.ok(settle?.success, "facilitator reported settlement success");
  const sig = settle?.transaction;
  assert.ok(sig, "settlement carries a transaction signature");
  console.log(`settlement signature: ${sig}`);

  // ---- independent verification against a public RPC ----
  let tx: Record<string, unknown> | null = null;
  for (let i = 0; i < 10 && !tx; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const resp = await fetch(PUBLIC_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
      }),
    });
    const body = (await resp.json()) as { result?: Record<string, unknown> | null };
    tx = body.result ?? null;
  }
  assert.ok(tx, `transaction ${sig} found on public RPC`);
  const meta = tx.meta as { err: unknown; preTokenBalances?: Array<Record<string, unknown>>; postTokenBalances?: Array<Record<string, unknown>> };
  assert.equal(meta.err, null, "on-chain tx has no error");

  // Verify a USDC delta of exactly +0.001 to the payTo owner.
  const post = meta.postTokenBalances ?? [];
  const pre = meta.preTokenBalances ?? [];
  const findAmt = (arr: Array<Record<string, unknown>>, owner: string) => {
    const e = arr.find(
      (b) => b.owner === owner && b.mint === USDC_MINT,
    ) as { uiTokenAmount?: { amount?: string } } | undefined;
    return e?.uiTokenAmount?.amount != null ? Number(e.uiTokenAmount.amount) : 0;
  };
  const recvDelta = findAmt(post, SETTLE_PAYTO) - findAmt(pre, SETTLE_PAYTO);
  const payDelta = findAmt(post, payerAddress) - findAmt(pre, payerAddress);
  console.log(`RPC-verified USDC deltas: payTo ${recvDelta > 0 ? "+" : ""}${recvDelta} micro, payer ${payDelta} micro`);
  assert.equal(recvDelta, 1000, "payTo received exactly 1000 micro-USDC ($0.001)");
  assert.equal(payDelta, -1000, "payer sent exactly 1000 micro-USDC");

  console.log(
    `SETTLE PROOF PASS: hook->sign->settle order proven; tx ${sig} independently verified on ${PUBLIC_RPC}`,
  );
}

const phase = process.argv[2];
const main = phase === "block" ? phaseBlock : phase === "settle" ? phaseSettle : null;
if (!main) {
  console.error("usage: tsx mcp-presign-proof.ts <block|settle>");
  process.exit(2);
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`${phase} phase FAILED:`, e);
    process.exit(1);
  });
