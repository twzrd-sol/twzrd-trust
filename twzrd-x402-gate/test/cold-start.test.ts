/**
 * Cold-start — pure. No network. Live 402s live in test/live/cold-start.test.ts.
 * Run: npx tsx --test test/cold-start.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_COLD_START_DIET,
  HelpError,
  REFUSE_FIXTURE_PAYTO,
  buildPolicy,
  hostnameOf,
  isForbiddenHost,
  isForbiddenPayTo,
  isForbiddenUrl,
  parseArgs,
  type ColdStartHostRow,
} from "../src/cold-start.js";

function row(partial: Partial<ColdStartHostRow> & Pick<ColdStartHostRow, "status" | "reason" | "resource_url">): ColdStartHostRow {
  return {
    role: "diet",
    host: null,
    pay_to: null,
    network: null,
    price_usdc: null,
    http_status: null,
    decision: null,
    approved: false,
    wash_flagged: null,
    abort: false,
    ...partial,
  };
}

test("parseArgs: defaults, repeated diet-url, help, spend refused", () => {
  const a = parseArgs([]);
  assert.deepEqual(a.dietUrls, [...DEFAULT_COLD_START_DIET]);
  assert.equal(a.hop, true);
  assert.equal(a.integration, "demo-cold-start");
  assert.equal(a.maxPerCallUsdc, 0.05);
  assert.equal(a.maxPerDayUsdc, 0.5);
  assert.equal(a.policyOut, "policy.json");
  const b = parseArgs([
    "--diet-url",
    DEFAULT_COLD_START_DIET[0]!,
    "--diet-url",
    DEFAULT_COLD_START_DIET[1]!,
    "--no-hop",
    "--policy-out",
    "/tmp/p.json",
  ]);
  assert.deepEqual(b.dietUrls, [DEFAULT_COLD_START_DIET[0], DEFAULT_COLD_START_DIET[1]]);
  assert.equal(b.hop, false);
  assert.equal(b.policyOut, "/tmp/p.json");
  assert.throws(() => parseArgs(["--spend"]), /--spend is refused/);
  assert.throws(() => parseArgs(["--help"]), (e: unknown) => e instanceof HelpError);
  assert.throws(() => parseArgs(["--diet-url", "http://insecure.example/x"]), /https/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown flag/);
});

test("default diet is foreign https and not a TWZRD host", () => {
  assert.equal(DEFAULT_COLD_START_DIET.length, 3);
  const hosts = new Set<string>();
  for (const url of DEFAULT_COLD_START_DIET) {
    assert.equal(isForbiddenUrl(url), false, url);
    const host = hostnameOf(url);
    assert.ok(host);
    hosts.add(host);
    assert.equal(isForbiddenHost(host), false, host);
  }
  assert.equal(hosts.size, 3, "three independently controlled hosts");
});

test("forbidden helpers: twzrd, loopback, refuse fixture", () => {
  assert.equal(isForbiddenUrl("https://intel.twzrd.xyz/v1/intel/resources"), true);
  assert.equal(isForbiddenUrl("https://intel.twzrd.xyz/v1/intel/refuse-fixture"), true);
  assert.equal(isForbiddenHost("localhost"), true);
  assert.equal(isForbiddenPayTo(REFUSE_FIXTURE_PAYTO), true);
  assert.equal(isForbiddenPayTo(null), false);
  assert.equal(isForbiddenPayTo("SellerNotTheRefuseFixture11111111111111111"), false);
  assert.equal(hostnameOf(DEFAULT_COLD_START_DIET[1]!), "defi.hugen.tokyo");
});

test("buildPolicy de-dupes host+payTo and only keeps allowlisted rows", () => {
  const policy = buildPolicy({
    maxPerCallUsdc: 0.05,
    maxPerDayUsdc: 0.5,
    hosts: [
      row({
        resource_url: "https://a.example/x",
        host: "a.example",
        pay_to: "PayToA",
        network: "solana",
        price_usdc: 0.01,
        http_status: 402,
        decision: "allow",
        approved: true,
        reason: "twzrd_allow",
        wash_flagged: false,
        status: "allowlisted",
      }),
      row({
        resource_url: "https://a.example/x",
        host: "a.example",
        pay_to: "PayToA",
        network: "solana",
        price_usdc: 0.01,
        http_status: 402,
        decision: "allow",
        approved: true,
        reason: "twzrd_allow",
        wash_flagged: false,
        status: "allowlisted",
      }),
      row({
        resource_url: "https://b.example/y",
        host: "b.example",
        pay_to: "PayToB",
        status: "refused",
        reason: "twzrd_wash_flagged",
        wash_flagged: true,
        abort: true,
      }),
      row({
        role: "hop",
        resource_url: "",
        host: null,
        status: "no_eligible_hop",
        reason: "no_eligible_hop",
      }),
    ],
  });
  assert.equal(policy.hosts.length, 1);
  assert.equal(policy.hosts[0]?.pay_to, "PayToA");
});
