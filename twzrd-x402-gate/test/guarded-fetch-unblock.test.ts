import assert from "node:assert/strict";
import { x402Version } from "@x402/core";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { x402Client } from "@x402/fetch";
import { findDefaultAsset } from "@x402/svm";
import { createGuardedX402Fetch, explainCoreSpendControls } from "../src/guarded-x402-fetch.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function challenge(network: `${string}:${string}`, asset: string, amount: string): PaymentRequired {
  return {
    x402Version,
    resource: { url: "https://merchant.example/paid" },
    accepts: [{ scheme: "exact", network, asset, amount, payTo: SELLER, maxTimeoutSeconds: 60, extra: {} }],
  };
}

function fakeScheme(onSign: () => void): SchemeNetworkClient {
  return {
    scheme: "exact",
    findDefaultAsset,
    async createPaymentPayload() {
      onSign();
      throw new Error("fake-signer-stop");
    },
  };
}

async function main() {
  // 1. Circle devnet USDC (the @x402/svm devnet default) passes the USDC check
  //    under a spend rule and reaches the signer. Before, it was refused as
  //    unsupported_or_non_usdc_asset, so devnet agents could not spend at all.
  {
    let signed = 0;
    const client = new x402Client();
    client.register(DEVNET, fakeScheme(() => signed++));
    createGuardedX402Fetch({ client, maxPricePerCall: "0.05", twzrd: { disabled: true }, fetch: fetch });
    await assert.rejects(client.createPaymentPayload(challenge(DEVNET, DEVNET_USDC, "1000")), /fake-signer-stop/);
    assert.equal(signed, 1, "devnet USDC under a price cap must reach the signer");
  }

  // 1b. The devnet mint named on MAINNET is some other token: still refused.
  {
    let signed = 0;
    const client = new x402Client();
    client.register(MAINNET, fakeScheme(() => signed++));
    client.setSpendControls(false);
    createGuardedX402Fetch({ client, maxPricePerCall: "0.05", twzrd: { disabled: true }, fetch: fetch });
    await assert.rejects(
      client.createPaymentPayload(challenge(MAINNET, DEVNET_USDC, "1000")),
      /unsupported_or_non_usdc_asset/,
    );
    assert.equal(signed, 0, "a devnet mint on mainnet must not pass as USDC");
  }

  // 2. A real @x402/core default-spend-control refusal is rewrapped with the fix.
  {
    let signed = 0;
    const client = new x402Client();
    client.register(MAINNET, fakeScheme(() => signed++));
    let coreError: unknown;
    try {
      await client.createPaymentPayload(challenge(MAINNET, MAINNET_USDC, "2000000"));
    } catch (error) {
      coreError = error;
    }
    assert.ok(coreError instanceof Error && /spendControls/.test(coreError.message), "core must refuse $2 by default");
    assert.equal(signed, 0);
    const explained = explainCoreSpendControls(coreError) as Error;
    assert.match(explained.message, /setSpendControls\(false\)/);
    assert.match(explained.message, /does NOT disable them/);
    assert.equal(explained.cause, coreError);
  }

  // 3. Anything that is not a core spend-control refusal passes through untouched.
  {
    const other = new Error("network down");
    assert.equal(explainCoreSpendControls(other), other);
  }

  console.log("guarded-fetch-unblock: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
