/**
 * AUDIT: x402 client hook — kill-switch scope + Payment Control coverage.
 *
 * 1. installTwzrdAutoGate(client) permanently replaces client.onBeforePaymentCreation
 *    with a registrar that gates EVERY hook behind TWZRD's kill switch. The host's
 *    own policy hooks registered afterwards are silenced by TWZRD_AUTO_GATE=0 or
 *    uninstallTwzrdAutoGate — "gate off" turned into "all host policy off".
 * 2. evaluateBeforePaymentCreation skips Payment Control when `amount` is missing,
 *    with a comment claiming the legacy gate denies it. It does not: a preflight
 *    `allow` proceeds to sign with mandate / policy ceilings never evaluated.
 * Offline, deterministic. Run: npx tsx test/audit-hook-scope.test.ts
 */
import assert from "node:assert/strict";

import { installTwzrdAutoGate, uninstallTwzrdAutoGate } from "../src/auto-gate.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import {
  createTwzrdBeforePaymentHook,
  installTwzrdX402ClientHook,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type X402ClientLike,
} from "../src/x402-client-hook.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
type Hook = (ctx: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>;

const allowIntel: typeof fetch = (async (url: unknown) =>
  String(url).includes("/merchant_card/")
    ? new Response("{}", { status: 404 })
    : new Response(JSON.stringify({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true } }), { status: 200 })
) as unknown as typeof fetch;

/** Multi-hook registry shaped like @x402/core: run in order, first abort wins. */
function multiHookClient() {
  const hooks: Hook[] = [];
  class Client implements X402ClientLike {
    onBeforePaymentCreation(h: Hook) { hooks.push(h); return this; }
  }
  const client = new Client();
  return {
    client,
    hooks,
    async fire(ctx: BeforePaymentCreationContext) {
      for (const h of hooks) { const r = await h(ctx); if (r && "abort" in r) return r; }
      return undefined;
    },
  };
}
const ctx = (over: Record<string, unknown> = {}): BeforePaymentCreationContext => ({
  selectedRequirements: { payTo: SELLER, network: SOL, amount: "1000", resource: "https://m.example/p", ...over },
});

async function run() {
  // 1a. TWZRD_AUTO_GATE=0 must not silence the HOST's own hook.
  {
    const { client, fire } = multiHookClient();
    installTwzrdAutoGate(client, { fetch: allowIntel });
    let host = 0;
    client.onBeforePaymentCreation(async () => { host += 1; return { abort: true, reason: "host policy" }; });
    process.env.TWZRD_AUTO_GATE = "0";
    try {
      const r = await fire(ctx());
      assert.equal(host, 1, "kill switch silenced a host hook registered after install");
      assert.deepEqual(r, { abort: true, reason: "host policy" });
    } finally {
      delete process.env.TWZRD_AUTO_GATE;
    }
    assert.ok(!Object.prototype.hasOwnProperty.call(client, "onBeforePaymentCreation"), "registrar left patched");
  }

  // 1b. uninstallTwzrdAutoGate must only disable TWZRD, not the host hook.
  {
    const { client, fire } = multiHookClient();
    installTwzrdAutoGate(client, { fetch: allowIntel });
    let host = 0;
    client.onBeforePaymentCreation(async () => { host += 1; return undefined; });
    uninstallTwzrdAutoGate(client);
    await fire(ctx());
    assert.equal(host, 1, "uninstall silenced a host hook");
  }

  // 2a. paymentControl with an empty allowlist must abort even when amount is missing.
  {
    const { client, fire } = multiHookClient();
    let decisions = 0;
    installTwzrdX402ClientHook(client, {
      fetch: allowIntel,
      paymentControl: { signer: createLocalDecisionSigner(), policy: { allowlist: [] } },
      onDecision: () => { decisions += 1; },
    });
    const r = await fire(ctx({ amount: undefined }));
    assert.ok(r && "abort" in r && r.abort === true, "Payment Control skipped: proceeded to sign with no amount");
    assert.match(String((r as { reason: string }).reason), /payment_control/);
    assert.equal(decisions, 1);
  }

  // 2b. Same through the stock PayAI beforePayment seat with amount "".
  {
    const hook = createTwzrdBeforePaymentHook({
      fetch: allowIntel,
      paymentControl: { signer: createLocalDecisionSigner(), policy: { maxAmountUsd: "0" } },
    });
    const r = await hook({ payTo: SELLER, network: SOL, amount: "" }, { requestUrl: "https://m.example/p" });
    assert.ok(r && "abort" in r && r.abort === true, "maxAmountUsd:0 bypassed by an empty amount");
  }

  console.log("audit-hook-scope.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("audit-hook-scope.test.ts FAILED:", e);
  process.exit(1);
});
