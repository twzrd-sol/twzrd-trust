/**
 * A Solana network label is the seller's word, not a property of the payment.
 *
 * The x402 Solana clients take the mint from the requirement and the cluster
 * from their own RPC. A requirement labeled `solana-devnet` that names the
 * mainnet USDC mint is therefore a mainnet payment on a mainnet-configured
 * client. The gate used to treat the keyword label as an unscored network:
 * no preflight, no asset check, observe-mode allow. It now refuses any named
 * asset that is not the labeled cluster's own USDC mint.
 *
 * Run: npx tsx --test test/solana-label-asset.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate_x402_resource } from "../src/evaluate.js";
import { createTwzrdGate } from "../src/gate.js";
import type { X402PaymentRequirements } from "../src/types.js";
import { createTwzrdBeforePaymentHook } from "../src/x402-client-hook.js";

const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDT_MAINNET = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const PAID_URL = "https://merchant.example/paid";
const KEYWORD_LABELS = ["solana-devnet", "solana:devnet", "devnet", "SOLANA-DEVNET", "solana-testnet", "solana:localnet"];

/** Intel that would BLOCK this seller on mainnet, counting what is asked of it. */
function blockingIntel() {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/merchant_card/")) return Response.json({ wash_flagged: false, wash_confidence: "full" });
    return Response.json({ readiness_card: { decision: "block", trust_score: 5, can_spend: false } });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl, preflights: () => calls.filter((u) => u.includes("/preflight")).length };
}

const offer = (network: string, asset: string | undefined) =>
  ({ payTo: SELLER, network, amount: "1000000", resource: PAID_URL, ...(asset === undefined ? {} : { asset }) });
const aborted = (r: { abort?: boolean } | void | undefined) => Boolean(r && r.abort === true);

test("control: the same seller is blocked by preflight under the mainnet label", async () => {
  const intel = blockingIntel();
  const result = await createTwzrdBeforePaymentHook({ fetch: intel.fetch })(offer("solana", USDC_MAINNET));
  assert.equal(aborted(result), true);
  assert.equal(intel.preflights(), 1);
});

test("a devnet, testnet or localnet label does not carry a mainnet mint past the gate", async () => {
  for (const network of KEYWORD_LABELS) {
    for (const asset of [USDC_MAINNET, USDT_MAINNET]) {
      const intel = blockingIntel();
      const hook = await createTwzrdBeforePaymentHook({ fetch: intel.fetch })(offer(network, asset));
      assert.equal(aborted(hook), true, `${network} + ${asset}: hook must abort`);
      assert.match(String(hook && hook.reason), /twzrd_non_usdc_asset/, `${network} + ${asset}`);

      const gate = await createTwzrdGate({ fetch: intel.fetch }).approvePayment({
        payTo: SELLER, chain: network, priceUsdc: 1, asset,
      });
      assert.equal(gate.approved, false, `${network} + ${asset}: gate`);
      assert.equal(gate.reason, "twzrd_non_usdc_asset");
      assert.equal(gate.reputationScored, false, "refused as a mislabeled asset, not on a score");

      const evaluated = await evaluate_x402_resource(
        PAID_URL, offer(network, asset) as unknown as X402PaymentRequirements, { fetch: intel.fetch },
      );
      assert.equal(evaluated.approved, false, `${network} + ${asset}: evaluate`);
      assert.equal(evaluated.reason, "twzrd_non_usdc_asset");
      assert.deepEqual(intel.calls, [], "refused before any intel call");
    }
  }
});

test("the opt-outs do not reopen it", async () => {
  // refuseWashFlagged: false used to return the observe allow with no check at all.
  const intel = blockingIntel();
  const hook = await createTwzrdBeforePaymentHook({ fetch: intel.fetch, refuseWashFlagged: false })(
    offer("solana-devnet", USDC_MAINNET),
  );
  assert.equal(aborted(hook), true);
  assert.match(String(hook && hook.reason), /twzrd_non_usdc_asset/);
});

test("a devnet requirement that names devnet USDC, or no asset, keeps its observe allow", async () => {
  for (const asset of [USDC_DEVNET, undefined]) {
    const intel = blockingIntel();
    const hook = await createTwzrdBeforePaymentHook({ fetch: intel.fetch })(offer("solana-devnet", asset));
    assert.equal(aborted(hook), false, `asset ${asset}: ${JSON.stringify(hook)}`);
    assert.equal(intel.preflights(), 0, "an unscored cluster is not preflighted");
  }
  // testnet and localnet have no USDC mint on record: only an unnamed asset passes.
  const intel = blockingIntel();
  const unnamed = await createTwzrdBeforePaymentHook({ fetch: intel.fetch })(offer("solana-testnet", undefined));
  assert.equal(aborted(unnamed), false);
});

test("strict mode and other chains are unchanged", async () => {
  const intel = blockingIntel();
  const strict = await createTwzrdGate({ fetch: intel.fetch, unsupportedNetworkMode: "strict" }).approvePayment({
    payTo: SELLER, chain: "solana-devnet", priceUsdc: 1, asset: USDC_MAINNET,
  });
  assert.equal(strict.approved, false);
  assert.equal(strict.reason, "network_not_scored");

  // An unscored EVM chain keeps its observe allow whatever the asset: the signature names the chain.
  const polygon = await createTwzrdGate({ fetch: intel.fetch, refuseWashFlagged: false }).approvePayment({
    payTo: "0x1111111111111111111111111111111111111111", chain: "eip155:137", priceUsdc: 1,
    asset: "0x2222222222222222222222222222222222222222",
  });
  assert.equal(polygon.approved, true);
  assert.equal(polygon.reason, "network_not_scored");
});
