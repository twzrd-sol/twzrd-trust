/**
 * Offline E2E: real x402ResourceServer + mock FacilitatorClient + TWZRD settle guard.
 *
 * No network, no RPC, no USDC spend. Green criteria:
 *  1. Real x402ResourceServer wiring invokes onBeforeSettle
 *  2. Abort prevents facilitator settlement (settle call count = 0)
 *  3. Hook exceptions fail closed (no facilitator settle)
 *  4. Allow path calls mocked settlement exactly once with expected payload
 *
 * Run from package root:
 *   NODE_PATH=../../node_modules npx tsx e2e/seller-settle-guard-x402-core.ts
 *
 * Exit 0 = GATE_PASS; non-zero = GATE_FAIL.
 */
import assert from "node:assert/strict";

import { x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

import {
  createTwzrdSettleGuard,
  type PayerScreen,
} from "../src/seller-hook.js";

const NETWORK = "test:network";
const SCHEME = "test-scheme";

type SettleCall = { payload: PaymentPayload; requirements: PaymentRequirements };

class TrackingMockFacilitator implements FacilitatorClient {
  settleCalls: SettleCall[] = [];
  verifyCalls = 0;
  getSupportedCalls = 0;

  async getSupported(): Promise<SupportedResponse> {
    this.getSupportedCalls++;
    return {
      kinds: [{ x402Version: 2, scheme: SCHEME, network: NETWORK, extra: {} }],
      extensions: [],
      signers: {},
    };
  }

  async verify(
    _payload: PaymentPayload,
    _requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.verifyCalls++;
    return { isValid: true };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.settleCalls.push({ payload, requirements });
    return {
      success: true,
      transaction: "mock-tx-no-chain",
      network: NETWORK as SettleResponse["network"],
    };
  }

  reset() {
    this.settleCalls = [];
    this.verifyCalls = 0;
    this.getSupportedCalls = 0;
  }
}

function requirements(): PaymentRequirements {
  return {
    scheme: SCHEME,
    network: NETWORK as PaymentRequirements["network"],
    amount: "50000",
    asset: "USDC_TEST",
    payTo: "seller_test_recipient",
    maxTimeoutSeconds: 300,
    extra: {},
  };
}

function payload(payer: string): PaymentPayload {
  return {
    x402Version: 2,
    payload: {
      // defaultExtractPayer probes payload.payer / from / authorization.from / account
      payer,
      signature: "mock-sig",
    },
    accepted: requirements(),
    resource: {
      url: "https://example.test/resource",
      description: "offline e2e resource",
      mimeType: "application/json",
    },
  };
}

function offlineScreen(payer: string): PayerScreen | null {
  if (payer.startsWith("WASH")) return { washFlagged: true, reason: "e2e_wash" };
  if (payer.startsWith("BLOCK")) return { decision: "block", reason: "e2e_block" };
  if (payer.startsWith("CLEAN")) return { washFlagged: false, decision: "allow" };
  if (payer.startsWith("THROW")) throw new Error("e2e_screen_boom");
  return null; // fail-open path (default guard)
}

function errorReason(err: unknown): string {
  const any = err as { errorReason?: string; message?: string };
  return (
    any.errorReason ||
    (typeof any.message === "string" ? any.message : "") ||
    String(err)
  );
}

async function main() {
  const decisions: Array<{ payer: string | null; aborted: boolean; reason: string }> = [];
  const mock = new TrackingMockFacilitator();
  const server = new x402ResourceServer(mock);
  let onBeforeSettleInvocations = 0;

  // Criterion 1: real ResourceServer public attach point
  server.onBeforeSettle(async (ctx) => {
    onBeforeSettleInvocations++;
    // Chain TWZRD guard as production would: one registered hook body.
    // (Multi-hook order is core-owned; we prove our guard via a single registration.)
    return createTwzrdSettleGuard({
      screen: offlineScreen,
      onDecision: (info) => {
        decisions.push({
          payer: info.payer,
          aborted: info.aborted,
          reason: info.reason,
        });
      },
    })(ctx);
  });

  // initialize so supported kinds are mapped (same path production uses)
  await server.initialize();
  assert.equal(mock.getSupportedCalls, 1, "initialize should call getSupported once");

  // --- 1) wash payer: abort before facilitator settle ---
  mock.reset();
  decisions.length = 0;
  const washBefore = onBeforeSettleInvocations;
  let washErr: unknown;
  try {
    await server.settlePayment(payload("WASH_sybil"), requirements());
  } catch (e) {
    washErr = e;
  }
  assert.ok(washErr, "wash settle must throw SettleError");
  const washReason = errorReason(washErr);
  assert.match(
    washReason,
    /twzrd_payer_wash_flagged|wash/i,
    `wash abort reason unexpected: ${washReason}`,
  );
  assert.equal(mock.settleCalls.length, 0, "facilitator.settle must NOT run on wash abort");
  assert.equal(onBeforeSettleInvocations, washBefore + 1, "onBeforeSettle invoked for wash");
  assert.equal(decisions.length, 1, "onDecision fired for wash");
  assert.equal(decisions[0]?.aborted, true);

  // --- 2) clean payer: facilitator settle EXACTLY once with expected payload ---
  mock.reset();
  decisions.length = 0;
  const cleanPayload = payload("CLEAN_organic");
  const cleanReqs = requirements();
  const clean = await server.settlePayment(cleanPayload, cleanReqs);
  assert.equal(clean.success, true, "clean settle success");
  assert.equal(clean.transaction, "mock-tx-no-chain");
  assert.equal(mock.settleCalls.length, 1, "facilitator.settle runs exactly once for clean");
  assert.deepEqual(
    mock.settleCalls[0]?.payload,
    cleanPayload,
    "allow path must pass expected payload to facilitator.settle",
  );
  assert.deepEqual(
    mock.settleCalls[0]?.requirements,
    cleanReqs,
    "allow path must pass expected requirements to facilitator.settle",
  );
  assert.equal(decisions[0]?.aborted, false);

  // --- 3) block decision: abort, no settle ---
  mock.reset();
  let blockErr: unknown;
  try {
    await server.settlePayment(payload("BLOCK_me"), requirements());
  } catch (e) {
    blockErr = e;
  }
  assert.ok(blockErr, "block settle must throw");
  assert.equal(mock.settleCalls.length, 0, "no settle on block");

  // --- 4) unknown / no signal: fail-open continues to settle ---
  mock.reset();
  const open = await server.settlePayment(payload("UNKNOWN_payer"), requirements());
  assert.equal(open.success, true, "no-signal fail-open must settle");
  assert.equal(mock.settleCalls.length, 1);

  // --- 5) missing payer field: fail-open (no extract → continue) ---
  mock.reset();
  const barePayload: PaymentPayload = {
    x402Version: 2,
    payload: { signature: "x" },
    accepted: requirements(),
    resource: {
      url: "https://example.test/resource",
      description: "no payer",
      mimeType: "application/json",
    },
  };
  const bare = await server.settlePayment(barePayload, requirements());
  assert.equal(bare.success, true, "unresolved payer fail-open must settle");
  assert.equal(mock.settleCalls.length, 1);

  // --- 6) raw onBeforeSettle throw: core FAILS CLOSED (since @x402/core 2.30) ---
  // Up to 2.27, core caught a throwing beforeSettle hook, console.warn'd it and
  // settled anyway. 2.30 still warns, then throws SettleError(400,
  // "before_settle_hook_error") and never calls facilitator.settle. The guard does
  // not rely on either behavior: createTwzrdSettleGuard RETURNS {abort:true}
  // (case 7) or continue (case 8) and never throws, so a pin bump cannot flip its
  // decision. PayAI still swallows thrown hook errors (see toPayaiVerifyResult).
  const mockThrow = new TrackingMockFacilitator();
  const serverThrow = new x402ResourceServer(mockThrow);
  serverThrow.onBeforeSettle(async () => {
    throw new Error("raw_hook_exception");
  });
  await serverThrow.initialize();
  mockThrow.reset();
  await assert.rejects(
    serverThrow.settlePayment(payload("CLEAN_organic"), requirements()),
    (err: unknown) =>
      (err as { errorReason?: string }).errorReason === "before_settle_hook_error",
    "core contract (2.30): a raw hook throw aborts settlement with before_settle_hook_error",
  );
  assert.equal(
    mockThrow.settleCalls.length,
    0,
    "a raw hook throw must not reach facilitator.settle under @x402/core 2.30",
  );

  // --- 7) TWZRD screen throw + failOpen:false → abort, no settle ---
  const mockFc = new TrackingMockFacilitator();
  const serverFc = new x402ResourceServer(mockFc);
  serverFc.onBeforeSettle(
    createTwzrdSettleGuard({
      screen: offlineScreen,
      failOpen: false,
    }),
  );
  await serverFc.initialize();
  mockFc.reset();
  let fcErr: unknown;
  try {
    await serverFc.settlePayment(payload("THROW_boom"), requirements());
  } catch (e) {
    fcErr = e;
  }
  assert.ok(fcErr, "failOpen:false screen throw must abort");
  assert.match(errorReason(fcErr), /twzrd_screen_error|e2e_screen_boom/i);
  assert.equal(mockFc.settleCalls.length, 0, "failOpen:false must not call facilitator.settle");

  // Default guard (failOpen true): screen throw continues — revenue not blocked on infra
  mock.reset();
  const fo = await server.settlePayment(payload("THROW_boom"), requirements());
  assert.equal(fo.success, true, "default failOpen screen throw continues to settle");
  assert.equal(mock.settleCalls.length, 1);

  console.log(
    JSON.stringify(
      {
        gate: "seller_onBeforeSettle_x402ResourceServer_mock_facilitator",
        status: "GATE_PASS",
        spend: "none",
        network: NETWORK,
        green_criteria: {
          real_x402ResourceServer_onBeforeSettle: true,
          abort_prevents_facilitator_settle: true,
          hook_exceptions_fail_closed: true,
          allow_path_settle_once_with_expected_payload: true,
        },
        cases: [
          "wash_aborts_before_facilitator_settle",
          "clean_settles_once_expected_payload",
          "block_aborts",
          "unknown_fail_open",
          "missing_payer_fail_open",
          "raw_hook_exception_fails_closed_in_core_2_30",
          "screen_throw_failOpen_false_aborts",
          "screen_throw_default_failOpen_continues",
        ],
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error("GATE_FAIL", e);
  process.exit(1);
});
