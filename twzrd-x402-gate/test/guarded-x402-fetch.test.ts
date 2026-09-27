import assert from "node:assert/strict";
import { x402Version } from "@x402/core";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { x402Client } from "@x402/fetch";
import { createGuardedX402Fetch } from "../src/guarded-x402-fetch.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const OTHER = "4Gndn4YtDfh3UBG8yVJeD8vU9ugG3X1n4vS4xbx7sNqG";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

function challenge(amount: string, payTo = SELLER, asset = USDC): PaymentRequired {
  return {
    x402Version,
    resource: { url: "https://merchant.example/paid" },
    accepts: [{ scheme: "exact", network: NETWORK, asset, amount, payTo, maxTimeoutSeconds: 60, extra: {} }],
  };
}

function clientFor(onSign: () => void) {
  // Keep this compatible with x402/core releases whose public config type
  // predates spendControls while disabling the newer default in local tests.
  const config = { schemes: [], spendControls: false as const };
  const client = x402Client.fromConfig(config);
  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    async createPaymentPayload() {
      onSign();
      throw new Error("fake-signer-stop");
    },
  };
  client.register(NETWORK, scheme);
  return client;
}

async function fire(client: x402Client, payment: PaymentRequired) {
  return client.createPaymentPayload(payment);
}

async function main() {
  const previousSwitch = process.env.TWZRD_GATE_ENABLED;
  process.env.TWZRD_GATE_ENABLED = "false";
  try {
    // Per-call ceiling blocks before the registered payment scheme is invoked.
    {
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({ client, maxPricePerCall: "0.05" });
      await assert.rejects(fire(client, challenge("50001")), /price_cap_exceeded/);
      assert.equal(signs, 0);
    }

    // An explicit recipient allowlist is applied to the selected requirement.
    {
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({ client, allowedRecipients: [SELLER] });
      await assert.rejects(fire(client, challenge("1000", OTHER)), /unauthorized_recipient/);
      assert.equal(signs, 0);
    }

    // The hourly reservation includes signer failures and prevents concurrent
    // calls from both passing against the same remaining balance.
    {
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({ client, hourlyBudgetCap: "0.05" });
      await assert.rejects(fire(client, challenge("30000")), /fake-signer-stop/);
      await assert.rejects(fire(client, challenge("30000")), /hourly_budget_exceeded/);
      assert.equal(signs, 1);
    }

    // Budget entries expire after 60 minutes.
    {
      let clock = 100_000;
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({
        client,
        hourlyBudgetCap: "0.03",
        now: () => clock,
      });
      await assert.rejects(fire(client, challenge("30000")), /fake-signer-stop/);
      clock += 60 * 60 * 1000 + 1;
      await assert.rejects(fire(client, challenge("30000")), /fake-signer-stop/);
      assert.equal(signs, 2);
    }

    // Concurrent calls reserve budget before the asynchronous TWZRD lookup.
    {
      delete process.env.TWZRD_GATE_ENABLED;
      let signs = 0;
      let gateCalls = 0;
      let releaseGate!: () => void;
      let announceGate!: () => void;
      const gateStarted = new Promise<void>((resolve) => { announceGate = resolve; });
      const gateHold = new Promise<void>((resolve) => { releaseGate = resolve; });
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({
        client,
        hourlyBudgetCap: "0.05",
        twzrd: {
          gateOnCanSpend: false,
          refuseWashFlagged: false,
          fetch: (async () => {
            gateCalls++;
            announceGate();
            await gateHold;
            return new Response(JSON.stringify({
              readiness_card: { decision: "allow", can_spend: true, trust_score: 90, seller_wallet: SELLER },
            }), { status: 200, headers: { "content-type": "application/json" } });
          }) as typeof fetch,
        },
      });
      const first = fire(client, challenge("30000")).catch((error: unknown) => error);
      await gateStarted;
      await assert.rejects(fire(client, challenge("30000")), /hourly_budget_exceeded/);
      releaseGate();
      const firstError = await first;
      assert.match(String((firstError as Error).message), /fake-signer-stop/);
      assert.equal(gateCalls, 1);
      assert.equal(signs, 1);
      process.env.TWZRD_GATE_ENABLED = "false";
    }

    // A TWZRD hook refusal releases its pending reservation and does not
    // commit the amount to the rolling spend ledger.
    {
      delete process.env.TWZRD_GATE_ENABLED;
      let signs = 0;
      let gateCalls = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({
        client,
        hourlyBudgetCap: "0.03",
        twzrd: {
          gateOnCanSpend: true,
          refuseWashFlagged: false,
          fetch: (async () => {
            gateCalls++;
            const blocked = gateCalls === 1;
            return new Response(JSON.stringify({
              readiness_card: {
                decision: blocked ? "block" : "allow",
                can_spend: !blocked,
                trust_score: blocked ? 1 : 90,
                seller_wallet: SELLER,
              },
            }), { status: 200, headers: { "content-type": "application/json" } });
          }) as typeof fetch,
        },
      });
      await assert.rejects(fire(client, challenge("30000")), /twzrd_decision_block|twzrd_can_spend_false/);
      await assert.rejects(fire(client, challenge("30000")), /fake-signer-stop/);
      assert.equal(gateCalls, 2);
      assert.equal(signs, 1);
      process.env.TWZRD_GATE_ENABLED = "false";
    }

    // Caps refuse unknown token identities instead of treating every six-
    // decimal token as USDC.
    {
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({ client, maxPricePerCall: "0.05" });
      await assert.rejects(fire(client, challenge("1000", SELLER, "not-usdc")), /unsupported_or_non_usdc_asset/);
      assert.equal(signs, 0);
    }

    // The existing TWZRD evaluator runs after local rules and before signing.
    {
      delete process.env.TWZRD_GATE_ENABLED;
      let signs = 0;
      let gateCalls = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({
        client,
        twzrd: {
          gateOnCanSpend: true,
          refuseWashFlagged: false,
          fetch: (async () => {
            gateCalls++;
            return new Response(JSON.stringify({
              readiness_card: { decision: "block", can_spend: false, trust_score: 1, seller_wallet: SELLER },
            }), { status: 200, headers: { "content-type": "application/json" } });
          }) as typeof fetch,
        },
      });
      await assert.rejects(fire(client, challenge("1000")), /twzrd_decision_block|twzrd_can_spend_false/);
      assert.equal(gateCalls > 0, true);
      assert.equal(signs, 0);
    }
  } finally {
    if (previousSwitch === undefined) delete process.env.TWZRD_GATE_ENABLED;
    else process.env.TWZRD_GATE_ENABLED = previousSwitch;
  }

  console.log("guarded-x402-fetch: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
