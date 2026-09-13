/**
 * Cold-start buyer loop — no spend. Injected fetch; never hits live 402s.
 * Run: npx tsx --test test/cold-start.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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

const INTEL = "https://intel.example";
const DIET_A = "https://minifetch.example/preview";
const DIET_B = "https://hugen.example/defi/tvl?protocol=aave";
const HOP = "https://grazer.example/paid";
const PAY_A = "PayToAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAY_B = "PayToBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PAY_HOP = "PayToHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";

function challenge(payTo: string, amount = "10000", network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") {
  return {
    x402Version: 2,
    error: "Payment required",
    accepts: [
      {
        scheme: "exact",
        network,
        payTo,
        amount,
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    ],
  };
}

function paymentRequiredHeader(payTo: string, amount?: string, network?: string) {
  return Buffer.from(JSON.stringify(challenge(payTo, amount, network))).toString("base64");
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function fakeFetch(opts: {
  wash?: Set<string>;
  amounts?: Record<string, string>;
  hopUrl?: string;
  hopPayTo?: string;
  missing402?: Set<string>;
} = {}): { fetch: typeof fetch; inits: Array<{ url: string; init?: RequestInit }> } {
  const inits: Array<{ url: string; init?: RequestInit }> = [];
  const wash = opts.wash ?? new Set<string>();
  const amounts = opts.amounts ?? {};
  const hopUrl = opts.hopUrl ?? HOP;
  const hopPayTo = opts.hopPayTo ?? PAY_HOP;
  const missing402 = opts.missing402 ?? new Set<string>();
  const payByUrl: Record<string, string> = {
    [DIET_A]: PAY_A,
    [DIET_B]: PAY_B,
    [hopUrl]: hopPayTo,
  };
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    inits.push({ url, init });
    if (url.startsWith(`${INTEL}/v1/intel/preflight`)) {
      const seller = JSON.parse(String(init?.body ?? "{}")).seller_wallet as string;
      const flagged = wash.has(seller);
      return json({
        readiness_card: {
          decision: flagged ? "warn" : "allow",
          can_spend: true,
          trust_score: flagged ? 45 : 80,
          seller_wallet: seller,
        },
        preflight_id: 1,
      });
    }
    if (url.startsWith(`${INTEL}/v1/intel/merchant_card/`)) {
      const seller = decodeURIComponent(url.split("/merchant_card/")[1] ?? "");
      return json({ merchant: seller, wash_flagged: wash.has(seller) });
    }
    if (url.startsWith(`${INTEL}/v1/intel/resources`)) {
      return json({
        resources: [
          { resource_url: hopUrl, pay_to: hopPayTo, live_402: true, listed: true },
        ],
      });
    }
    if (missing402.has(url)) return json({ ok: true }, 200);
    const payTo = payByUrl[url];
    if (payTo) {
      const amount = amounts[url] ?? "10000";
      return json(
        {},
        402,
        { "PAYMENT-REQUIRED": paymentRequiredHeader(payTo, amount) },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, inits };
}

function args(extra: string[] = []) {
  return parseArgs([
    "--diet-url",
    DIET_A,
    "--diet-url",
    DIET_B,
    "--intel-base",
    INTEL,
    "--integration",
    "demo-cold-start",
    "--run-id",
    "run-fixed",
    ...extra,
  ]);
}

test("parseArgs: defaults, repeated diet-url, help, spend refused", () => {
  const a = parseArgs([]);
  assert.deepEqual(a.dietUrls, [...DEFAULT_COLD_START_DIET]);
  assert.equal(a.hop, true);
  assert.equal(a.integration, "demo-cold-start");
  assert.equal(a.maxPerCallUsdc, 0.05);
  assert.equal(a.maxPerDayUsdc, 0.5);
  assert.equal(a.policyOut, "policy.json");
  const b = parseArgs(["--diet-url", DIET_A, "--diet-url", DIET_B, "--no-hop", "--policy-out", "/tmp/p.json"]);
  assert.deepEqual(b.dietUrls, [DIET_A, DIET_B]);
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
  assert.equal(isForbiddenPayTo(PAY_A), false);
  assert.equal(hostnameOf(DIET_B), "hugen.example");
});

test("run: AutoGate wired, two diet hosts allowlisted, hop once, signer 0", async () => {
  const dir = tempDir("twzrd-cold-start-");
  const { fetch, inits } = fakeFetch();
  const files = new Map<string, string>();
  const { transcript, policy, exitCode } = await runColdStart(
    { ...args(["--policy-out", join(dir, "policy.json"), "--out", join(dir, "out.json")]), hop: true },
    {
      fetch,
      now: () => "2026-09-13T00:00:00.000Z",
      writeFile: (path, contents) => {
        files.set(path, contents);
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(transcript.schema, COLD_START_TRANSCRIPT_SCHEMA);
  assert.equal(transcript.mode, "no_spend");
  assert.equal(transcript.lineage, "dogfood");
  assert.equal(transcript.signer_invocation_count, 0);
  assert.equal(transcript.payment_retry_count, 0);
  assert.equal(transcript.usdc_spent, 0);
  assert.equal(transcript.autogate.wired, true);
  assert.equal(transcript.autogate.install, AUTOGATE_INSTALL_SNIPPET);
  assert.equal(transcript.ok, true);
  assert.equal(policy.schema, COLD_START_POLICY_SCHEMA);
  assert.equal(policy.mode, "default_deny");
  assert.equal(policy.refuse_wash_flagged, true);
  assert.ok(policy.hosts.some((h) => h.host === "minifetch.example" && h.pay_to === PAY_A));
  assert.ok(policy.hosts.some((h) => h.host === "hugen.example" && h.pay_to === PAY_B));
  assert.ok(policy.hosts.some((h) => h.host === "grazer.example" && h.pay_to === PAY_HOP));
  assert.equal(transcript.allowlisted_count, 3);
  assert.equal(transcript.hosts.filter((h) => h.role === "hop").length, 1);
  assert.ok(files.get(join(dir, "policy.json"))?.includes(COLD_START_POLICY_SCHEMA));
  assert.ok(
    inits.every((c) => {
      const headers = new Headers(c.init?.headers);
      return !headers.has("payment-signature") && !headers.has("x-payment") && !headers.has("payment");
    }),
    "probes never attach a payment header",
  );
  assert.ok(inits.some((c) => c.init?.signal instanceof AbortSignal), "fetches are bounded");
});

test("wash_flagged diet host is refused, not allowlisted", async () => {
  const { fetch } = fakeFetch({ wash: new Set([PAY_A]) });
  const { transcript, policy } = await runColdStart(
    { ...args(["--no-hop", "--policy-out", "policy.json"]) },
    { fetch, writeFile: () => undefined },
  );
  const row = transcript.hosts.find((h) => h.pay_to === PAY_A);
  assert.equal(row?.status, "refused");
  assert.equal(row?.approved, false);
  assert.equal(row?.abort, true);
  assert.equal(policy.hosts.some((h) => h.pay_to === PAY_A), false);
  assert.equal(policy.hosts.some((h) => h.pay_to === PAY_B), true);
  assert.equal(transcript.signer_invocation_count, 0);
});

test("price above max_per_call is over_cap, not allowlisted", async () => {
  const { fetch } = fakeFetch({ amounts: { [DIET_A]: "1000000" } }); // $1.00
  const { transcript, policy } = await runColdStart(
    { ...args(["--no-hop", "--max-per-call-usdc", "0.05", "--policy-out", "p.json"]) },
    { fetch, writeFile: () => undefined },
  );
  const row = transcript.hosts.find((h) => h.resource_url === DIET_A);
  assert.equal(row?.status, "over_cap");
  assert.equal(policy.hosts.some((h) => h.pay_to === PAY_A), false);
});

test("TWZRD diet URL is forbidden and hop skips the diet host", async () => {
  const { fetch } = fakeFetch();
  const parsed = parseArgs([
    "--diet-url",
    "https://intel.twzrd.xyz/v1/intel/refuse-fixture",
    "--diet-url",
    DIET_A,
    "--intel-base",
    INTEL,
    "--integration",
    "acme-ops-agent-v1",
    "--run-id",
    "ext-1",
    "--policy-out",
    "p.json",
  ]);
  const { transcript } = await runColdStart(parsed, { fetch, writeFile: () => undefined });
  assert.equal(transcript.lineage, "external_candidate");
  const forbidden = transcript.hosts.find((h) => h.resource_url.includes("refuse-fixture"));
  assert.equal(forbidden?.status, "forbidden");
  assert.equal(transcript.hosts.filter((h) => h.host === "minifetch.example").length, 1);
  const hop = transcript.hosts.find((h) => h.role === "hop" && h.host === "grazer.example");
  assert.ok(hop);
});

test("not-402 diet is recorded; hop still attempted", async () => {
  const { fetch } = fakeFetch({ missing402: new Set([DIET_B]) });
  const { transcript } = await runColdStart(
    { ...args(["--policy-out", "p.json"]) },
    { fetch, writeFile: () => undefined },
  );
  assert.equal(transcript.hosts.find((h) => h.resource_url === DIET_B)?.status, "not_402");
  assert.equal(transcript.hosts.some((h) => h.role === "hop" && h.host === "grazer.example"), true);
});

test("buildPolicy de-dupes host+payTo and only keeps allowlisted rows", () => {
  const policy = buildPolicy({
    maxPerCallUsdc: 0.05,
    maxPerDayUsdc: 0.5,
    hosts: [
      {
        role: "diet",
        resource_url: DIET_A,
        host: "minifetch.example",
        pay_to: PAY_A,
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
        resource_url: DIET_A,
        host: "minifetch.example",
        pay_to: PAY_A,
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
        resource_url: DIET_B,
        host: "hugen.example",
        pay_to: PAY_B,
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
  assert.equal(policy.hosts[0]?.pay_to, PAY_A);
});
