/**
 * Cold-start buyer loop — no spend. Live 402 + intel probes; no injected fetch.
 * Run: npx tsx --test test/cold-start.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AUTOGATE_INSTALL_SNIPPET,
  COLD_START_POLICY_SCHEMA,
  COLD_START_TRANSCRIPT_SCHEMA,
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
} from "../src/cold-start.js";
import { tempDir } from "./helpers/tmpdir.js";

const LIVE = { timeout: 120_000 };

function assertNoSpend(transcript: Awaited<ReturnType<typeof runColdStart>>["transcript"]) {
  assert.equal(transcript.mode, "no_spend");
  assert.equal(transcript.signer_invocation_count, 0);
  assert.equal(transcript.payment_retry_count, 0);
  assert.equal(transcript.usdc_spent, 0);
  assert.equal(transcript.autogate.wired, true);
  assert.equal(transcript.ok, true);
  for (const host of transcript.policy.hosts) {
    assert.equal(isForbiddenHost(host.host), false, host.host);
    assert.equal(isForbiddenPayTo(host.pay_to), false, host.pay_to);
    assert.equal(isForbiddenUrl(host.resource_url), false, host.resource_url);
  }
  for (const row of transcript.hosts) {
    if (row.wash_flagged === true) {
      assert.notEqual(row.status, "allowlisted", `${row.resource_url} wash_flagged must not allowlist`);
    }
  }
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
  assert.equal(isForbiddenPayTo("SellerNotTheRefuseFixture11111111111111111"), false);
  assert.equal(hostnameOf(DEFAULT_COLD_START_DIET[1]!), "defi.hugen.tokyo");
});

test("live: AutoGate on real 402s, signer 0, no TWZRD hosts", LIVE, async () => {
  const dir = tempDir("twzrd-cold-start-");
  const policyPath = join(dir, "policy.json");
  const outPath = join(dir, "out.json");
  const { transcript, policy, exitCode } = await runColdStart(
    parseArgs([
      "--policy-out",
      policyPath,
      "--out",
      outPath,
      "--integration",
      "demo-cold-start",
      "--run-id",
      "live-cold-start",
    ]),
  );
  assert.equal(exitCode, 0);
  assert.equal(transcript.schema, COLD_START_TRANSCRIPT_SCHEMA);
  assert.equal(transcript.lineage, "dogfood");
  assert.equal(transcript.autogate.install, AUTOGATE_INSTALL_SNIPPET);
  assertNoSpend(transcript);
  assert.equal(policy.schema, COLD_START_POLICY_SCHEMA);
  assert.equal(policy.mode, "default_deny");
  assert.equal(policy.refuse_wash_flagged, true);
  for (const url of DEFAULT_COLD_START_DIET) {
    assert.ok(
      transcript.hosts.some((h) => h.role === "diet" && h.resource_url === url),
      `diet ${url} recorded`,
    );
  }
  const hopRows = transcript.hosts.filter((h) => h.role === "hop");
  assert.equal(hopRows.length, 1);
  const written = JSON.parse(readFileSync(policyPath, "utf8")) as { schema: string };
  assert.equal(written.schema, COLD_START_POLICY_SCHEMA);
});

test("live: wash_flagged never allowlisted", LIVE, async () => {
  const dir = tempDir("twzrd-cold-start-");
  const { transcript } = await runColdStart(
    parseArgs(["--no-hop", "--policy-out", join(dir, "policy.json")]),
  );
  assertNoSpend(transcript);
  for (const row of transcript.hosts) {
    if (row.wash_flagged === true) {
      assert.equal(row.approved, false);
      assert.notEqual(row.status, "allowlisted");
    }
  }
});

test("live: max_per_call 0 keeps priced 402s off the allowlist", LIVE, async () => {
  const dir = tempDir("twzrd-cold-start-");
  const { transcript, policy } = await runColdStart(
    parseArgs([
      "--no-hop",
      "--max-per-call-usdc",
      "0",
      "--policy-out",
      join(dir, "policy.json"),
    ]),
  );
  assertNoSpend(transcript);
  for (const row of transcript.hosts) {
    if (row.price_usdc != null && row.price_usdc > 0 && row.http_status === 402) {
      assert.notEqual(row.status, "allowlisted", row.resource_url);
    }
  }
  assert.equal(
    policy.hosts.every((h) => h.price_usdc == null || h.price_usdc <= 0),
    true,
  );
});

test("live: TWZRD refuse-fixture is forbidden; example.com is not 402", LIVE, async () => {
  const dir = tempDir("twzrd-cold-start-");
  const { transcript } = await runColdStart(
    parseArgs([
      "--diet-url",
      "https://intel.twzrd.xyz/v1/intel/refuse-fixture",
      "--diet-url",
      "https://example.com/",
      "--no-hop",
      "--integration",
      "acme-ops-agent-v1",
      "--run-id",
      "ext-1",
      "--policy-out",
      join(dir, "policy.json"),
    ]),
  );
  assert.equal(transcript.lineage, "external_candidate");
  assertNoSpend(transcript);
  const forbidden = transcript.hosts.find((h) => h.resource_url.includes("refuse-fixture"));
  assert.equal(forbidden?.status, "forbidden");
  const example = transcript.hosts.find((h) => h.resource_url === "https://example.com/");
  assert.ok(example);
  assert.notEqual(example.status, "allowlisted");
  assert.ok(example.status === "not_402" || example.status === "probe_error");
});

test("buildPolicy de-dupes host+payTo and only keeps allowlisted rows", () => {
  const policy = buildPolicy({
    maxPerCallUsdc: 0.05,
    maxPerDayUsdc: 0.5,
    hosts: [
      {
        role: "diet",
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
        abort: false,
      },
      {
        role: "diet",
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
        abort: false,
      },
      {
        role: "diet",
        resource_url: "https://b.example/y",
        host: "b.example",
        pay_to: "PayToB",
        network: "solana",
        price_usdc: 0.01,
        http_status: 402,
        decision: "block",
        approved: false,
        reason: "twzrd_wash_flagged",
        wash_flagged: true,
        status: "refused",
        abort: true,
      },
    ],
  });
  assert.equal(policy.hosts.length, 1);
  assert.equal(policy.hosts[0]?.pay_to, "PayToA");
});
