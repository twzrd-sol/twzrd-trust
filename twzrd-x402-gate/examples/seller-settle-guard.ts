/**
 * Example: seller-side pre-settlement payer screening on x402ResourceServer.
 *
 * A resource server (SELLER) refuses to settle payments from wash/sybil payers
 * so its own demand-quality reputation stays clean. TWZRD is advisory + fail-open
 * and never in the settlement path.
 *
 * Real wiring (with @x402/core installed) is one line:
 *
 *   import { x402ResourceServer } from "@x402/core";
 *   import { createTwzrdSettleGuard, twzrdPayerScreen } from "twzrd-x402-gate";
 *
 *   const server = new x402ResourceServer(facilitator);
 *   server.onBeforeSettle(createTwzrdSettleGuard({ screen: twzrdPayerScreen() }));
 *   // onBeforeSettle is inherited by @x402/express|hono|next|fastify + python x402.
 *
 * Run offline (default, no network): npx tsx examples/seller-settle-guard.ts
 * Run live against TWZRD:            npx tsx examples/seller-settle-guard.ts --live <payerWallet>
 */
import {
  createTwzrdSettleGuard,
  twzrdPayerScreen,
  type SettleGuardContext,
  type PayerScreen,
} from "../src/seller-hook.js";

// Minimal stand-in for the shape of x402ResourceServer we depend on: a settler
// that consults onBeforeSettle and refuses when the hook returns { abort }.
class MockResourceServer {
  private hook: ((ctx: SettleGuardContext) => Promise<unknown>) | null = null;
  onBeforeSettle(hook: (ctx: SettleGuardContext) => Promise<unknown>) {
    this.hook = hook;
    return this;
  }
  async settle(ctx: SettleGuardContext): Promise<{ settled: boolean; reason?: string }> {
    if (this.hook) {
      const r = (await this.hook(ctx)) as { abort?: true; reason?: string } | void;
      if (r && r.abort) return { settled: false, reason: r.reason };
    }
    return { settled: true };
  }
}

function payerCtx(payer: string): SettleGuardContext {
  return { paymentPayload: { payload: { payer } }, requirements: {} };
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const liveWallet = live ? args[args.indexOf("--live") + 1] : undefined;

  // Offline screen: deterministic, no network. Live path uses the real free
  // merchant_card via twzrdPayerScreen().
  const offlineScreen = (payer: string): PayerScreen =>
    payer.startsWith("WASH")
      ? { washFlagged: true, reason: "demo_wash" }
      : { washFlagged: false, decision: "allow", reason: "demo_clean" };

  const server = new MockResourceServer().onBeforeSettle(
    createTwzrdSettleGuard({
      screen: live ? twzrdPayerScreen() : offlineScreen,
      onDecision: (i) =>
        console.log(
          `  [twzrd] payer=${i.payer ?? "?"} aborted=${i.aborted} reason=${i.reason}`,
        ),
    }),
  );

  if (live && liveWallet) {
    console.log(`Live screen of payer ${liveWallet} via ${"https://intel.twzrd.xyz"}:`);
    const res = await server.settle(payerCtx(liveWallet));
    console.log(`  -> ${res.settled ? "SETTLE" : `REFUSE (${res.reason})`}`);
    return;
  }

  console.log("Offline demo (pass --live <wallet> to screen a real payer):\n");
  for (const payer of ["WASH_sybil_payer", "CLEAN_organic_payer"]) {
    const res = await server.settle(payerCtx(payer));
    console.log(`payer=${payer} -> ${res.settled ? "SETTLE" : `REFUSE (${res.reason})`}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
