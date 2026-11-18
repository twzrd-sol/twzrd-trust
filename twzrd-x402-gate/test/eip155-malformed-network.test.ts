/**
 * A non-canonical eip155 reference must not pass as an unscored chain.
 * Payment clients read the chain id leniently (Circle's BatchEvmScheme uses
 * parseInt(network.split(":")[1]); @x402/evm uses /^eip155:(\d+)$/), so
 * "eip155:08453" signs for Base chain id 8453. Observe mode used to allow it
 * with no preflight, no price cap and no asset check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyNetwork, decideUnsupportedNetwork, EIP155_CANONICAL_RE } from "../src/network.js";
import { resolveConfig } from "../src/config.js";
import { twzrdApprovePayment } from "../src/policy.js";

const BLOCKED_SELLER = "0xbad0000000000000000000000000000000000bad";
const MALFORMED = ["eip155:08453", "eip155:008453", "eip155:8453x", "eip155:8453.0", "eip155:8453:1", "eip155:+8453", "eip155: 8453", "eip155:", "eip155:0x2105", "eip155:0X2105", "eip155:010453", "eip155:８４５３", "eip155:8453e0"];

function noIntel(): typeof fetch {
  return (async () => {
    throw new Error("intel must not be called for a malformed eip155 network");
  }) as unknown as typeof fetch;
}

test("classifyNetwork marks non-canonical eip155 references malformed", () => {
  for (const n of MALFORMED) {
    const c = classifyNetwork(n, BLOCKED_SELLER);
    assert.equal(c.reason, "network_malformed", n);
    assert.equal(c.reputationScored, false, n);
  }
});

test("canonical eip155 ids keep their old classification", () => {
  assert.equal(classifyNetwork("eip155:8453").reason, "base_scored");
  assert.equal(classifyNetwork(" EIP155:8453 ").reason, "base_scored");
  for (const n of ["eip155:1", "eip155:5042", "eip155:5042002", "eip155:84532", "eip155:0"]) {
    assert.ok(EIP155_CANONICAL_RE.test(n), n);
    assert.equal(classifyNetwork(n).reason, "network_not_scored", n);
  }
});

test("decideUnsupportedNetwork blocks a malformed id in observe mode too", () => {
  for (const mode of ["observe", "strict"] as const) {
    const d = decideUnsupportedNetwork(classifyNetwork("eip155:08453"), mode);
    assert.equal(d.policyAction, "block", mode);
    assert.equal(d.approved, false, mode);
    assert.equal(d.reason, "network_malformed", mode);
  }
  assert.equal(decideUnsupportedNetwork(classifyNetwork("eip155:5042"), "observe").policyAction, "allow");
});

test("twzrdApprovePayment refuses a Base alias before intel in observe mode", async () => {
  for (const chain of MALFORMED) {
    const d = await twzrdApprovePayment(
      { payTo: BLOCKED_SELLER, chain, priceUsdc: 1_000_000, resourceUrl: "https://seller.example/api" },
      resolveConfig({ unsupportedNetworkMode: "observe", failOpen: false, fetch: noIntel() }),
    );
    assert.equal(d.approved, false, chain);
    assert.equal(d.reason, "network_malformed", chain);
  }
});
