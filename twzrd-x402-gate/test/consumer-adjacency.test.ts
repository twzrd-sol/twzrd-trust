/**
 * Consumer adjacency rail router (Muse/Instinct/OpenClaw-class).
 * Solana x402 → TWZRD preflight path. Stripe/Link/Tempo → hand off, no Solana wash.
 * Evidence objects stay named distinctly.
 *
 * Run: npx tsx --test test/consumer-adjacency.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EVIDENCE_OBJECTS,
  decideSolanaConsumerAction,
  describeEvidenceObject,
  routeConsumerAccept,
  routeConsumer402,
} from "../src/consumer-adjacency.js";

describe("routeConsumerAccept", () => {
  it("routes solana network + real payTo to solana_twzrd", () => {
    const r = routeConsumerAccept({
      network: "solana",
      payTo: "CnTmHDXVEafkc8sFSzNky9w5zwk63Bk2mHZZodorjhvR",
    });
    assert.equal(r.rail, "solana_twzrd");
    assert.equal(r.reason, "solana_accept");
    assert.equal(r.runTwzrdPreflight, true);
    assert.equal(r.handOff, null);
  });

  it("routes CAIP-2 solana mainnet the same way", () => {
    const r = routeConsumerAccept({
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      payTo: "AAyBzWYM5MQPcTQC3hgU5hXvGvtA4V1RbzUDuukXpWsq",
    });
    assert.equal(r.rail, "solana_twzrd");
    assert.equal(r.runTwzrdPreflight, true);
  });

  it("refuses empty or template payTo on a solana accept", () => {
    for (const payTo of ["", "{pubkey}", ":pubkey", "PAY_TO_WALLET", "SELLER_WALLET"]) {
      const r = routeConsumerAccept({ network: "solana", payTo });
      assert.equal(r.rail, "refuse", payTo);
      assert.equal(r.reason, "empty_or_template_payto");
      assert.equal(r.runTwzrdPreflight, false);
      assert.equal(r.canSign, false);
    }
  });

  it("hands stripe method to stripe_link without Solana wash", () => {
    const r = routeConsumerAccept({
      network: "eip155:8453",
      method: "stripe",
      payTo: "cus_example",
    });
    assert.equal(r.rail, "stripe_link");
    assert.equal(r.reason, "stripe_or_link_method");
    assert.equal(r.runTwzrdPreflight, false);
    assert.equal(r.handOff, "stripe-link-cli");
  });

  it("hands Link and Tempo markers to stripe_link", () => {
    const link = routeConsumerAccept({ method: "link", network: "tempo" });
    assert.equal(link.rail, "stripe_link");
    assert.equal(link.runTwzrdPreflight, false);

    const tempo = routeConsumerAccept({ scheme: "tempo", method: "mpp" });
    assert.equal(tempo.rail, "stripe_link");
    assert.equal(tempo.handOff, "mpp-agent");
  });

  it("does not treat bare EVM as stripe_link or solana_twzrd wash path", () => {
    const r = routeConsumerAccept({
      network: "eip155:8453",
      payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
    });
    assert.equal(r.rail, "other_unscored");
    assert.equal(r.runTwzrdPreflight, false);
    assert.notEqual(r.handOff, "stripe-link-cli");
  });
});

describe("routeConsumer402", () => {
  it("prefers solana_twzrd when any accept is solana with real payTo", () => {
    const r = routeConsumer402({
      accepts: [
        { method: "stripe", network: "tempo" },
        {
          network: "solana",
          payTo: "CnTmHDXVEafkc8sFSzNky9w5zwk63Bk2mHZZodorjhvR",
        },
      ],
    });
    assert.equal(r.primary.rail, "solana_twzrd");
    assert.equal(r.hasSolana, true);
    assert.equal(r.hasStripeLink, true);
    assert.equal(r.note, "run_twzrd_on_solana_accept_only");
  });

  it("primary is stripe_link when only stripe/link/tempo accepts exist", () => {
    const r = routeConsumer402({
      accepts: [{ method: "stripe" }, { scheme: "tempo" }],
    });
    assert.equal(r.primary.rail, "stripe_link");
    assert.equal(r.hasSolana, false);
    assert.equal(r.primary.runTwzrdPreflight, false);
  });

  it("refuses when accepts missing or all unusable", () => {
    assert.equal(routeConsumer402({}).primary.rail, "refuse");
    assert.equal(routeConsumer402({ accepts: [] }).primary.rail, "refuse");
    assert.equal(
      routeConsumer402({ accepts: [{ network: "solana", payTo: "{pubkey}" }] }).primary
        .rail,
      "refuse",
    );
  });
});

describe("decideSolanaConsumerAction", () => {
  it("hard-stops only on decision=block", () => {
    const r = decideSolanaConsumerAction({
      preflightDecision: "block",
      washFlagged: false,
    });
    assert.equal(r.action, "do_not_pay");
    assert.equal(r.reason, "preflight_block");
    assert.equal(r.canSign, false);
  });

  it("hard-stops when merchant_card next_action refuses", () => {
    const r = decideSolanaConsumerAction({
      preflightDecision: "allow",
      washFlagged: false,
      merchantNextAction: "refuse",
    });
    assert.equal(r.action, "do_not_pay");
    assert.equal(r.reason, "merchant_card_refuses");
    assert.equal(r.canSign, false);
  });

  it("wash + warn caps and escalates — does not hard-stop", () => {
    const r = decideSolanaConsumerAction({
      preflightDecision: "warn",
      washFlagged: true,
      recommendedCapUsdc: 0.01,
      priceUsdc: 0.005,
    });
    assert.equal(r.action, "pay_capped");
    assert.equal(r.reason, "wash_escalate");
    assert.equal(r.canSign, true);
    assert.equal(r.escalatePathA, true);
    assert.equal(r.recommendedCapUsdc, 0.01);
  });

  it("price above recommended cap refuses", () => {
    const r = decideSolanaConsumerAction({
      preflightDecision: "warn",
      washFlagged: true,
      recommendedCapUsdc: 0.01,
      priceUsdc: 0.05,
    });
    assert.equal(r.action, "do_not_pay");
    assert.equal(r.reason, "price_exceeds_cap");
    assert.equal(r.canSign, false);
  });

  it("clean allow may pay", () => {
    const r = decideSolanaConsumerAction({
      preflightDecision: "allow",
      washFlagged: false,
    });
    assert.equal(r.action, "pay");
    assert.equal(r.reason, "preflight_allow");
    assert.equal(r.canSign, true);
  });
});

describe("evidence objects stay distinct", () => {
  it("exports three named kinds and never collapses labels", () => {
    assert.deepEqual(EVIDENCE_OBJECTS, [
      "witness_shopping_receipt",
      "payment_decision_v1",
      "intel_receipt_v6_v7",
    ]);
    const labels = EVIDENCE_OBJECTS.map(describeEvidenceObject);
    assert.equal(new Set(labels).size, 3);
    for (const label of labels) {
      assert.notEqual(label.toLowerCase(), "the receipt");
      assert.ok(label.length > 8);
    }
    assert.match(describeEvidenceObject("payment_decision_v1"), /payment_decision/);
    assert.match(describeEvidenceObject("intel_receipt_v6_v7"), /V6|V7|intel/i);
    assert.match(describeEvidenceObject("witness_shopping_receipt"), /witness/i);
  });
});
