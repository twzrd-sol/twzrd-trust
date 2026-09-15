/**
 * Cold-start live 402 + intel probes. Not on the default `test/*.test.ts` glob.
 * Run: npm run cold-start-live --workspace=twzrd-x402-gate
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
  isForbiddenHost,
  isForbiddenPayTo,
  isForbiddenUrl,
  parseArgs,
  runColdStart,
} from "../../src/cold-start.js";
import { tempDir } from "../helpers/tmpdir.js";

const LIVE = { timeout: 120_000 };

function assertNoSpend(transcript: Awaited<ReturnType<typeof runColdStart>>["transcript"]) {
  assert.equal(transcript.mode, "no_spend");
  assert.equal(transcript.signer_invocation_count, 0);
  assert.equal(transcript.payment_retry_count, 0);
  assert.equal(transcript.usdc_spent, 0);
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

test("live: scores real 402s, signer 0, no TWZRD hosts", LIVE, async () => {
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
  assert.equal(transcript.schema, COLD_START_TRANSCRIPT_SCHEMA);
  assert.equal(transcript.lineage, "dogfood");
  assert.equal(transcript.autogate.install, AUTOGATE_INSTALL_SNIPPET);
  assertNoSpend(transcript);
  assert.equal(transcript.ok, true);
  assert.equal(exitCode, 0);
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
  assert.ok(
    hopRows[0] &&
      (hopRows[0].status === "no_eligible_hop" ||
        hopRows[0].status === "directory_error" ||
        hopRows[0].status === "allowlisted" ||
        hopRows[0].status === "refused" ||
        hopRows[0].status === "over_cap" ||
        hopRows[0].status === "probe_error"),
  );
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
    policy.hosts.every((h) => h.price_usdc != null && Number.isFinite(h.price_usdc) && h.price_usdc === 0),
    true,
  );
});

test("live: TWZRD refuse-fixture is forbidden; example.com is not 402", LIVE, async () => {
  const dir = tempDir("twzrd-cold-start-");
  const { transcript, exitCode } = await runColdStart(
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
  assert.equal(transcript.ok, false);
  assert.equal(exitCode, 1);
  const forbidden = transcript.hosts.find((h) => h.resource_url.includes("refuse-fixture"));
  assert.equal(forbidden?.status, "forbidden");
  const example = transcript.hosts.find((h) => h.resource_url === "https://example.com/");
  assert.ok(example);
  assert.notEqual(example.status, "allowlisted");
  assert.ok(example.status === "not_402" || example.status === "probe_error");
});
