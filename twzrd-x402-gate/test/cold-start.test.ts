/**
 * Cold-start — offline policy and mocked runner tests. No network.
 * Run: npx tsx --test test/cold-start.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { join, relative } from "node:path";
import { tempDir } from "./helpers/tmpdir.js";

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

test("runColdStart enforces known prices, including a zero cap", async (t) => {
  const dir = tempDir("cold-start-cap-");
  const seller = "https://seller.example/product";
  let amount: string | undefined;
  let amountField = "amount";
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (url === seller) return Response.json({ accepts: [{
      scheme: "exact", network: "solana", payTo: "Seller1111111111111111111111111111111111111",
      ...(amount === undefined ? {} : { [amountField]: amount }),
    }] }, { status: 402 });
    if (url.includes("/merchant_card/")) return Response.json({ wash_flagged: false });
    if (url.endsWith("/preflight")) return Response.json({
      readiness_card: { decision: "allow", trust_score: 90, can_spend: true },
    });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  for (amountField of ["amount", "maxAmountRequired"]) {
   for (const cap of [0, 0.05]) {
    for (amount of [undefined, "", " ", "garbage", "Infinity", "-1", "0", "50000", "50001"]) {
      const { policy, transcript } = await runColdStart(parseArgs([
        "--diet-url", seller, "--no-hop", "--max-per-call-usdc", String(cap),
        "--policy-out", join(dir, "policy.json"), "--out", join(dir, "transcript.json"),
      ]));
      const valid = amount !== undefined && /^\d+$/.test(amount);
      const allowed = valid && Number(amount) / 1e6 <= cap;
      assert.equal(policy.hosts.length, allowed ? 1 : 0, `amount=${amount}, cap=${cap}`);
      const host = transcript.hosts[0]!;
      assert.equal(host.status, allowed ? "allowlisted" : valid ? "over_cap" : "refused");
      if (!valid) {
        assert.equal(host.reason, "price_unknown");
        assert.equal(host.approved, false);
        assert.equal(host.abort, true);
      }
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")), policy);
      assert.equal(JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")).schema, transcript.schema);
    }
   }
  }
});

test("buildPolicy independently rejects unknown or out-of-cap prices", () => {
  for (const price of [null, NaN, Infinity, -1, 0.050001]) {
    const policy = buildPolicy({ maxPerCallUsdc: 0.05, maxPerDayUsdc: 0.5,
      hosts: [row({ status: "allowlisted", reason: "twzrd_allow", resource_url: "https://seller.example/",
        host: "seller.example", pay_to: "Seller", price_usdc: price })],
    });
    assert.deepEqual(policy.hosts, []);
  }
});

test("output collisions reject before fetch or writing existing policy", async (t) => {
  const dir = tempDir("cold-start-output-");
  const policy = join(dir, "policy.json");
  writeFileSync(policy, "preserve existing policy\n");
  const symlink = join(dir, "symlink.json");
  const hardlink = join(dir, "hardlink.json");
  symlinkSync(policy, symlink);
  linkSync(policy, hardlink);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not probe"); });
  for (const out of [policy, relative(process.cwd(), policy), symlink, hardlink]) {
    assert.throws(() => parseArgs(["--policy-out", policy, "--out", out]), /different files/);
    await assert.rejects(runColdStart({ ...parseArgs([]), policyOut: policy, out }), /different files/);
    assert.equal(readFileSync(policy, "utf8"), "preserve existing policy\n");
  }
  assert.throws(() => parseArgs(["--out", "./policy.json"]), /different files/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

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
