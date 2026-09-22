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
import type { HostResolver } from "../src/ssrf.js";

/**
 * Every seller hostname in this file is a non-resolving `*.example`
 * placeholder (RFC 6761 reserved TLD) behind a mocked `fetch` — there is no
 * real network here. hasForbiddenResolution does a real DNS lookup by
 * default, which would NXDOMAIN (fail closed -> "forbidden") for all of
 * them; inject a resolver that reports an ordinary public address instead
 * so these tests exercise pricing/policy logic, not DNS. Tests that exist
 * specifically to exercise the SSRF/DNS-rebinding path supply their own
 * resolver.
 */
const RESOLVE_PUBLIC: HostResolver = async () => [{ address: "93.184.216.34", family: 4 }];

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
      ]), { resolveHost: RESOLVE_PUBLIC });
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

test("a hop candidate whose live-resolved payTo duplicates an already-scored wallet is skipped, not double-recorded", async (t) => {
  const dir = tempDir("cold-start-hop-payto-dedup-");
  const dietSeller = "https://diet-seller.example/product";
  const dupHopUrl = "https://dup-hop.example/product";
  const sharedPayTo = "SharedSeller111111111111111111111111111111";
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (url === dietSeller) {
      return Response.json({ accepts: [{
        scheme: "exact", network: "solana", payTo: sharedPayTo, amount: "10000",
      }] }, { status: 402 });
    }
    if (url.includes("/v1/intel/resources")) {
      // The directory listing itself carries no payTo (legitimate per
      // directory.ts), so the pre-probe dedup on listing.payTo cannot catch
      // that this host will live-resolve to the same wallet as the diet row.
      return Response.json({
        resources: [{ resource_url: dupHopUrl, pay_to: null, live_402: true }],
      });
    }
    if (url === dupHopUrl) {
      return Response.json({ accepts: [{
        scheme: "exact", network: "solana", payTo: sharedPayTo, amount: "10000",
      }] }, { status: 402 });
    }
    if (url.includes("/merchant_card/")) return Response.json({ wash_flagged: false });
    if (url.endsWith("/preflight")) {
      return Response.json({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const { transcript } = await runColdStart(
    parseArgs(["--diet-url", dietSeller, "--policy-out", join(dir, "policy.json")]),
    { resolveHost: RESOLVE_PUBLIC },
  );
  const hop = transcript.hosts.find((h) => h.role === "hop");
  // The duplicate wallet must not be recorded as a second scored hop row.
  assert.notEqual(hop?.pay_to, sharedPayTo);
  const payToCount = transcript.hosts.filter((h) => h.pay_to === sharedPayTo).length;
  assert.equal(payToCount, 1, "the shared payTo is only scored once");
});

test("a wash-capped gate approval is still refused by cold-start, and the reason does not contradict the status", async (t) => {
  const dir = tempDir("cold-start-wash-cap-");
  const seller = "https://seller.example/product";
  const prevCap = process.env.TWZRD_WASH_MAX_USDC;
  process.env.TWZRD_WASH_MAX_USDC = "0.05";
  t.after(() => {
    if (prevCap === undefined) delete process.env.TWZRD_WASH_MAX_USDC;
    else process.env.TWZRD_WASH_MAX_USDC = prevCap;
  });
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (url === seller) {
      return Response.json({ accepts: [{
        scheme: "exact", network: "solana", payTo: "Seller1111111111111111111111111111111111111",
        amount: "10000",
      }] }, { status: 402 });
    }
    if (url.includes("/merchant_card/")) return Response.json({ wash_flagged: true });
    if (url.endsWith("/preflight")) {
      return Response.json({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const { transcript } = await runColdStart(parseArgs([
    "--diet-url", seller, "--no-hop", "--policy-out", join(dir, "policy.json"),
  ]), { resolveHost: RESOLVE_PUBLIC });
  const host = transcript.hosts[0]!;
  assert.equal(host.wash_flagged, true);
  assert.equal(host.approved, false);
  assert.equal(host.status, "refused");
  // Bug: previously `reason` was copied verbatim from the gate's own
  // wash-capped-allow reason, contradicting the "refused" status.
  assert.match(host.reason, /^cold_start_wash_flagged_refused/);
  assert.match(host.reason, /twzrd_wash_capped/);
});

test("ok credits a hop-scored host even when the exported API is called with no diet URLs", async (t) => {
  const dir = tempDir("cold-start-ok-hop-only-");
  const hopUrl = "https://hop-only-seller.example/product";
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (url.includes("/v1/intel/resources")) {
      return Response.json({
        resources: [{ resource_url: hopUrl, pay_to: "HopOnly111111111111111111111111111111111", live_402: true }],
      });
    }
    if (url === hopUrl) {
      return Response.json({ accepts: [{
        scheme: "exact", network: "solana", payTo: "HopOnly111111111111111111111111111111111",
        amount: "10000",
      }] }, { status: 402 });
    }
    if (url.includes("/merchant_card/")) return Response.json({ wash_flagged: false });
    if (url.endsWith("/preflight")) {
      return Response.json({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  // Bypasses the CLI's DEFAULT_COLD_START_DIET backfill — a direct
  // programmatic call with an empty dietUrls, per ColdStartArgs.
  const { transcript, exitCode } = await runColdStart(
    {
      ...parseArgs([]),
      dietUrls: [],
      policyOut: join(dir, "policy.json"),
      out: null,
    },
    { resolveHost: RESOLVE_PUBLIC },
  );
  assert.equal(transcript.hosts.some((h) => h.role === "diet"), false);
  const hop = transcript.hosts.find((h) => h.role === "hop");
  assert.equal(hop?.status, "allowlisted");
  assert.equal(transcript.ok, true, "a successful hop score must count toward ok");
  assert.equal(exitCode, 0);
});

test("a write failure on --policy-out is reported, not thrown, and the transcript is still returned", async (t) => {
  const dir = tempDir("cold-start-write-fail-");
  const seller = "https://seller.example/product";
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (url === seller) {
      return Response.json({ accepts: [{
        scheme: "exact", network: "solana", payTo: "Seller1111111111111111111111111111111111111",
        amount: "10000",
      }] }, { status: 402 });
    }
    if (url.includes("/merchant_card/")) return Response.json({ wash_flagged: false });
    if (url.endsWith("/preflight")) {
      return Response.json({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const errorMock = t.mock.method(console, "error", () => {});
  // A directory used as a file path cannot be written to — this is a
  // real-world stand-in for a bad/empty --policy-out, without relying on
  // platform-specific empty-string behavior.
  const badPolicyOut = dir;
  const { transcript, exitCode } = await runColdStart(
    {
      ...parseArgs(["--diet-url", seller, "--no-hop"]),
      policyOut: badPolicyOut,
      out: null,
    },
    { resolveHost: RESOLVE_PUBLIC },
  );
  assert.ok(transcript.policy_write_error, "the write failure is surfaced, not swallowed");
  assert.equal(transcript.policy_path, null);
  assert.equal(transcript.hosts[0]?.status, "allowlisted", "probing already completed and is preserved");
  assert.equal(transcript.ok, true);
  assert.equal(exitCode, 0);
  assert.ok(
    errorMock.mock.calls.some((c) => String(c.arguments[0]).includes("failed to write")),
    "the failure is reported on stderr",
  );
});
