/**
 * Cold-start — pure. No network: fetch and DNS resolution are always mocked
 * or injected. Live 402s live in test/live/cold-start.test.ts.
 * Run: npx tsx --test test/cold-start.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

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
  runColdStart,
  type ColdStartHostRow,
} from "../src/cold-start.js";
import { tempDir } from "./helpers/tmpdir.js";

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

test("runColdStart forbids a diet URL that is a private IP literal, with zero fetch calls", async (t) => {
  const dir = tempDir("cold-start-ssrf-literal-");
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch a forbidden literal target");
  });
  const { transcript } = await runColdStart(
    parseArgs([
      "--diet-url",
      "https://169.254.169.254/latest/meta-data",
      "--no-hop",
      "--policy-out",
      join(dir, "policy.json"),
    ]),
  );
  const diet = transcript.hosts.find((h) => h.role === "diet");
  assert.equal(diet?.status, "forbidden");
  assert.equal(diet?.reason, "forbidden_private_resolution");
  assert.equal(fetchMock.mock.callCount(), 0, "a private literal is never fetched");
});

test("runColdStart never probes a hop candidate that DNS-resolves to a private address", async (t) => {
  const dir = tempDir("cold-start-ssrf-hop-");
  const hopUrl = "https://rebinder.example/product";
  let hopProbed = false;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (url.includes("/v1/intel/resources")) {
      return Response.json({
        resources: [
          {
            resource_url: hopUrl,
            pay_to: "HopSeller11111111111111111111111111111111",
            live_402: true,
          },
        ],
      });
    }
    if (url === hopUrl) {
      hopProbed = true;
      throw new Error("must not probe a hop candidate once resolution is forbidden");
    }
    return new Response("", { status: 404 });
  });
  const { transcript } = await runColdStart(
    parseArgs(["--policy-out", join(dir, "policy.json")]),
    {
      resolveHost: async (host) =>
        host === "rebinder.example"
          ? [{ address: "10.0.0.9", family: 4 }]
          : [{ address: "93.184.216.34", family: 4 }],
    },
  );
  // Same fate as the pre-existing isForbiddenUrl hop filter: skipped, not scored.
  // No other listing exists, so the hop bucket reports no eligible candidate.
  const hop = transcript.hosts.find((h) => h.role === "hop");
  assert.equal(hop?.status, "no_eligible_hop");
  assert.equal(hopProbed, false, "the rebinding target must never be fetched");
});

test("runColdStart skips a private-resolving hop candidate and still attempts the next listing", async (t) => {
  const dir = tempDir("cold-start-ssrf-hop-next-");
  const poisonedUrl = "https://rebinder.example/product";
  const safeUrl = "https://safe-seller.example/product";
  let poisonedProbed = false;
  let safeProbed = false;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (url.includes("/v1/intel/resources")) {
      return Response.json({
        resources: [
          { resource_url: poisonedUrl, pay_to: "PoisonedSeller111111111111111111111111111", live_402: true },
          { resource_url: safeUrl, pay_to: "SafeSeller1111111111111111111111111111111", live_402: true },
        ],
      });
    }
    if (url === poisonedUrl) {
      poisonedProbed = true;
      throw new Error("must not probe a hop candidate once resolution is forbidden");
    }
    if (url === safeUrl) {
      safeProbed = true;
      return new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  });
  await runColdStart(
    parseArgs(["--policy-out", join(dir, "policy.json")]),
    {
      resolveHost: async (host) =>
        host === "rebinder.example"
          ? [{ address: "10.0.0.9", family: 4 }]
          : [{ address: "93.184.216.34", family: 4 }],
    },
  );
  // The private-resolving listing is skipped (never fetched); the loop still
  // reaches and probes the next listing rather than stopping at the first one.
  assert.equal(poisonedProbed, false);
  assert.equal(safeProbed, true, "the loop moves on to the next listing");
});
