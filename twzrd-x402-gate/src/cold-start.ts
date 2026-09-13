/**
 * Cold-start buyer loop — no spend.
 *
 * Turns a cold agent into a repeating buyer of *foreign* x402 hosts with
 * AutoGate already on the path: pinned diet → 402 probe → wash refuse →
 * default-deny policy.json → one directory hop. Never pays. Never lists a
 * TWZRD-operated seller as diet. Self-runs are dogfood until a foreign
 * --integration plus a server-side join (see gate-adoption-operator-proof.md).
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { resolveLineage, type GateAdoptionLineage } from "./adoption-proof.js";
import { installTwzrdAutoGate } from "./auto-gate.js";
import { listDirectoryCallables } from "./directory.js";
import {
  payToFromRequirements,
  paymentRequiredFromResponse,
  pickRequirements,
  priceUsdcFromAmountMicro,
} from "./payto.js";
import type { X402PaymentRequiredBody, X402PaymentRequirements } from "./types.js";
import { CLIENT_VERSION } from "./version.js";
import type { X402SelectedRequirements } from "./x402-client-hook.js";

export const COLD_START_TRANSCRIPT_SCHEMA = "twzrd.cold_start_transcript.v1" as const;
export const COLD_START_POLICY_SCHEMA = "twzrd.cold_start_policy.v1" as const;

/** Owned refuse dogfood — never a diet/hop target. */
export const REFUSE_FIXTURE_PAYTO = "CnTmHDXVEafkc8sFSzNky9w5zwk63Bk2mHZZodorjhvR";

/**
 * Pinned foreign GET 402s. Independently controlled sellers, not `*.twzrd`.
 * Live drift is recorded as a probe miss; it does not invent a catalog.
 */
export const DEFAULT_COLD_START_DIET: readonly string[] = [
  "https://minifetch.com/api/v1/x402/extract/url-preview?url=https://github.com",
  "https://defi.hugen.tokyo/defi/tvl?protocol=aave",
  "https://api.purch.xyz/x402/search?q=test",
];

export const DEFAULT_MAX_PER_CALL_USDC = 0.05;
export const DEFAULT_MAX_PER_DAY_USDC = 0.5;
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_INTEL = "https://intel.twzrd.xyz";

const NOT_EXTERNAL = [
  "package_download_counts",
  "preflight_hits_alone",
  "self_authored_run_id_alone",
  "twzrd_dogfood_or_ci",
  "this_transcript_alone_without_server_side_join",
  "allowlisted_hosts_are_not_path_b_seats",
] as const;

export const AUTOGATE_INSTALL_SNIPPET =
  'beforePayment: installTwzrdAutoGate("x402-solana", { refuseWashFlagged: true })';

export const USAGE = `usage: twzrd-cold-start [--diet-url <https url>]... [--no-hop]
         [--integration <id>] [--run-id <uuid>] [--policy-out policy.json] [--out transcript.json]
         [--intel-base https://intel.twzrd.xyz] [--max-per-call-usdc 0.05] [--max-per-day-usdc 0.50]

  Probe a pinned foreign x402 diet (not *.twzrd), run AutoGate (refuse wash) before
  any signer, write a default-deny policy.json, then hop once from GET /v1/intel/resources.
  Default is no spend. --spend is refused.

  Exit 0 writes policy + transcript (signer_invocation_count=0, usdc_spent=0).
  Exit 2 is a bad invocation. Self-serve is dogfood, not EXTERNAL_RUN.`;

export type ColdStartHostStatus =
  | "allowlisted"
  | "refused"
  | "over_cap"
  | "not_402"
  | "no_payto"
  | "forbidden"
  | "probe_error";

export type ColdStartHostRow = {
  role: "diet" | "hop";
  resource_url: string;
  host: string | null;
  pay_to: string | null;
  network: string | null;
  price_usdc: number | null;
  http_status: number | null;
  decision: string | null;
  approved: boolean;
  reason: string;
  wash_flagged: boolean | null;
  status: ColdStartHostStatus;
  abort: boolean;
};

export type ColdStartPolicyHost = {
  host: string;
  resource_url: string;
  pay_to: string;
  network: string | null;
  price_usdc: number | null;
};

export type ColdStartPolicy = {
  schema: typeof COLD_START_POLICY_SCHEMA;
  mode: "default_deny";
  refuse_wash_flagged: true;
  max_per_call_usdc: number;
  max_per_day_usdc: number;
  autogate: { refuseWashFlagged: true; install: string };
  hosts: ColdStartPolicyHost[];
};

export type ColdStartTranscript = {
  schema: typeof COLD_START_TRANSCRIPT_SCHEMA;
  package: "twzrd-x402-gate";
  packageVersion: string;
  mode: "no_spend";
  integration: string;
  runId: string;
  lineage: GateAdoptionLineage;
  clientHeader: string;
  autogate: {
    wired: true;
    refuseWashFlagged: true;
    install: string;
  };
  signer_invocation_count: 0;
  payment_retry_count: 0;
  usdc_spent: 0;
  diet_urls: string[];
  hop: boolean;
  hosts: ColdStartHostRow[];
  allowlisted_count: number;
  policy: ColdStartPolicy;
  policy_path: string | null;
  exportedAt: string;
  notExternalRunProof: string[];
  ok: boolean;
};

export type ColdStartArgs = {
  dietUrls: string[];
  hop: boolean;
  integration: string;
  runId: string;
  policyOut: string;
  out: string | null;
  intelBase: string;
  maxPerCallUsdc: number;
  maxPerDayUsdc: number;
};

export type ColdStartDeps = {
  fetch?: typeof fetch;
  now?: () => string;
  listCallables?: typeof listDirectoryCallables;
  writeFile?: (path: string, contents: string) => void;
};

const BOOLEAN_FLAGS = new Set(["--no-hop", "--help", "-h"]);
const VALUE_FLAGS = new Set([
  "--integration",
  "--run-id",
  "--out",
  "--policy-out",
  "--intel-base",
  "--max-per-call-usdc",
  "--max-per-day-usdc",
]);

function withTimeout(doFetch: typeof fetch): typeof fetch {
  return ((input, init) => {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return doFetch(input, { ...init, signal });
  }) as typeof fetch;
}

function httpsUrl(flag: string, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${flag} must be an https URL`);
  }
  if (u.protocol !== "https:") throw new Error(`${flag} must be an https URL`);
  return u.toString();
}

function nonNegative(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative number`);
  return n;
}

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isForbiddenHost(host: string | null): boolean {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  if (h === "twzrd.xyz" || h.endsWith(".twzrd.xyz")) return true;
  if (h.endsWith(".local")) return true;
  return false;
}

export function isForbiddenUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol !== "https:") return true;
  if (isForbiddenHost(u.hostname.toLowerCase().replace(/^www\./, ""))) return true;
  if (u.pathname.includes("/v1/intel/refuse-fixture")) return true;
  return false;
}

export function isForbiddenPayTo(payTo: string | null | undefined): boolean {
  if (!payTo) return false;
  return payTo === REFUSE_FIXTURE_PAYTO;
}

export function parseArgs(argv: string[]): ColdStartArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    throw new HelpError(USAGE);
  }
  if (argv.includes("--spend")) {
    throw new Error("--spend is refused; cold-start is no_spend only");
  }
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  const dietUrls: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    if (a === "--diet-url") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      dietUrls.push(httpsUrl("--diet-url", v));
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(a)) {
      switches.add(a);
      continue;
    }
    if (!VALUE_FLAGS.has(a)) throw new Error(`unknown flag ${a}`);
    if (flags.has(a)) throw new Error(`repeated flag ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    flags.set(a, v);
    i += 1;
  }
  const intelRaw = flags.get("--intel-base") ?? process.env.TWZRD_INTEL_BASE ?? DEFAULT_INTEL;
  return {
    dietUrls: dietUrls.length > 0 ? dietUrls : [...DEFAULT_COLD_START_DIET],
    hop: !switches.has("--no-hop"),
    integration: flags.get("--integration") ?? "demo-cold-start",
    runId: flags.get("--run-id") ?? randomUUID(),
    policyOut: flags.get("--policy-out") ?? "policy.json",
    out: flags.get("--out") ?? null,
    intelBase: httpsUrl("--intel-base", intelRaw).replace(/\/+$/, ""),
    maxPerCallUsdc: flags.has("--max-per-call-usdc")
      ? nonNegative("--max-per-call-usdc", flags.get("--max-per-call-usdc")!)
      : DEFAULT_MAX_PER_CALL_USDC,
    maxPerDayUsdc: flags.has("--max-per-day-usdc")
      ? nonNegative("--max-per-day-usdc", flags.get("--max-per-day-usdc")!)
      : DEFAULT_MAX_PER_DAY_USDC,
  };
}

export class HelpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelpError";
  }
}

async function probeUnpaid402(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{
  httpStatus: number | null;
  challenge: X402PaymentRequiredBody | null;
  req: X402PaymentRequirements;
  payTo: string | undefined;
  amountMicro: string | undefined;
  error: string | null;
}> {
  const resp = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (resp.status !== 402) {
    return {
      httpStatus: resp.status,
      challenge: null,
      req: {},
      payTo: undefined,
      amountMicro: undefined,
      error: "not_402",
    };
  }
  const challenge = await paymentRequiredFromResponse(resp);
  const req = pickRequirements(challenge?.accepts);
  const { payTo, amountMicro } = payToFromRequirements(req);
  if (!payTo) {
    return {
      httpStatus: 402,
      challenge,
      req,
      payTo: undefined,
      amountMicro,
      error: "no_payto",
    };
  }
  return { httpStatus: 402, challenge, req, payTo, amountMicro, error: null };
}

export function buildPolicy(input: {
  maxPerCallUsdc: number;
  maxPerDayUsdc: number;
  hosts: ColdStartHostRow[];
}): ColdStartPolicy {
  const hosts: ColdStartPolicyHost[] = [];
  const seen = new Set<string>();
  for (const row of input.hosts) {
    if (row.status !== "allowlisted" || !row.host || !row.pay_to) continue;
    const key = `${row.host}|${row.pay_to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hosts.push({
      host: row.host,
      resource_url: row.resource_url,
      pay_to: row.pay_to,
      network: row.network,
      price_usdc: row.price_usdc,
    });
  }
  return {
    schema: COLD_START_POLICY_SCHEMA,
    mode: "default_deny",
    refuse_wash_flagged: true,
    max_per_call_usdc: input.maxPerCallUsdc,
    max_per_day_usdc: input.maxPerDayUsdc,
    autogate: { refuseWashFlagged: true, install: AUTOGATE_INSTALL_SNIPPET },
    hosts,
  };
}

export async function runColdStart(
  args: ColdStartArgs,
  deps: ColdStartDeps = {},
): Promise<{ transcript: ColdStartTranscript; policy: ColdStartPolicy; exitCode: 0 }> {
  const fetchBound = withTimeout(deps.fetch ?? globalThis.fetch);
  const listCallables = deps.listCallables ?? listDirectoryCallables;
  const writeFile = deps.writeFile ?? ((path, contents) => writeFileSync(path, contents));
  const exportedAt = deps.now?.() ?? new Date().toISOString();
  const lineage = resolveLineage(args.integration);

  type DecisionSnap = {
    approved: boolean;
    reason: string;
    verdict: string;
    washFlagged: boolean | null;
  };
  let lastDecision: DecisionSnap | null = null;

  const beforePayment = installTwzrdAutoGate("x402-solana", {
    refuseWashFlagged: true,
    failOpen: false,
    gateOnCanSpend: false,
    intelBase: args.intelBase,
    fetch: fetchBound,
    attribution: { integration: args.integration, runId: args.runId },
    onDecision(detail) {
      lastDecision = {
        approved: detail.approved,
        reason: detail.reason,
        verdict: detail.verdict,
        washFlagged: /wash_flagged/.test(detail.reason) ? true : null,
      };
    },
  });

  async function gateRequirement(
    url: string,
    req: X402PaymentRequirements,
    _challenge: X402PaymentRequiredBody | null,
  ): Promise<DecisionSnap & { abort: boolean }> {
    lastDecision = null;
    const result = await beforePayment(req as X402SelectedRequirements & Record<string, unknown>, {
      requestUrl: url,
      declaredResource: { url },
    });
    const abort = result?.abort === true;
    const snap = lastDecision ?? {
      approved: !abort,
      reason: abort ? (result?.reason ?? "aborted") : "twzrd_allow",
      verdict: abort ? "block" : "allow",
      washFlagged: null,
    };
    return { ...snap, abort };
  }

  const rows: ColdStartHostRow[] = [];

  async function consider(url: string, role: "diet" | "hop"): Promise<ColdStartHostRow> {
    const host = hostnameOf(url);
    if (isForbiddenUrl(url) || isForbiddenHost(host)) {
      return {
        role,
        resource_url: url,
        host,
        pay_to: null,
        network: null,
        price_usdc: null,
        http_status: null,
        decision: null,
        approved: false,
        reason: "forbidden_twzrd_or_loopback",
        wash_flagged: null,
        status: "forbidden",
        abort: true,
      };
    }
    try {
      const probed = await probeUnpaid402(url, fetchBound);
      if (probed.error === "not_402") {
        return {
          role,
          resource_url: url,
          host,
          pay_to: null,
          network: null,
          price_usdc: null,
          http_status: probed.httpStatus,
          decision: null,
          approved: false,
          reason: "not_402",
          wash_flagged: null,
          status: "not_402",
          abort: false,
        };
      }
      if (probed.error === "no_payto" || !probed.payTo) {
        return {
          role,
          resource_url: url,
          host,
          pay_to: null,
          network: probed.req.network ?? null,
          price_usdc: priceUsdcFromAmountMicro(probed.amountMicro) ?? null,
          http_status: probed.httpStatus,
          decision: null,
          approved: false,
          reason: "no_payto",
          wash_flagged: null,
          status: "no_payto",
          abort: false,
        };
      }
      if (isForbiddenPayTo(probed.payTo)) {
        return {
          role,
          resource_url: url,
          host,
          pay_to: probed.payTo,
          network: probed.req.network ?? null,
          price_usdc: priceUsdcFromAmountMicro(probed.amountMicro) ?? null,
          http_status: probed.httpStatus,
          decision: null,
          approved: false,
          reason: "forbidden_refuse_fixture_payto",
          wash_flagged: null,
          status: "forbidden",
          abort: true,
        };
      }
      const price = priceUsdcFromAmountMicro(probed.amountMicro) ?? null;
      const gated = await gateRequirement(url, probed.req, probed.challenge);
      const washFlagged =
        gated.washFlagged === true || /wash_flagged/.test(gated.reason) ? true : gated.washFlagged;
      let status: ColdStartHostStatus = "refused";
      if (gated.approved && !gated.abort && washFlagged !== true) {
        if (price != null && price > args.maxPerCallUsdc) status = "over_cap";
        else status = "allowlisted";
      }
      return {
        role,
        resource_url: url,
        host,
        pay_to: probed.payTo,
        network: probed.req.network ?? null,
        price_usdc: price,
        http_status: probed.httpStatus,
        decision: gated.verdict,
        approved: gated.approved && !gated.abort,
        reason: gated.reason,
        wash_flagged: washFlagged,
        status,
        abort: gated.abort,
      };
    } catch (err) {
      return {
        role,
        resource_url: url,
        host,
        pay_to: null,
        network: null,
        price_usdc: null,
        http_status: null,
        decision: null,
        approved: false,
        reason: err instanceof Error ? err.message : String(err),
        wash_flagged: null,
        status: "probe_error",
        abort: false,
      };
    }
  }

  for (const url of args.dietUrls) {
    rows.push(await consider(url, "diet"));
  }

  if (args.hop) {
    const haveHost = new Set(rows.filter((r) => r.host).map((r) => r.host as string));
    const havePayTo = new Set(rows.filter((r) => r.pay_to).map((r) => r.pay_to as string));
    try {
      const listings = await listCallables({
        intelBase: args.intelBase,
        fetch: fetchBound,
        limit: 20,
        live402Only: true,
      });
      let hopped = false;
      let inspected = 0;
      for (const listing of listings) {
        if (inspected >= 8) break;
        const url = listing.resourceUrl;
        if (!url) continue;
        const host = hostnameOf(url);
        if (!host || isForbiddenUrl(url) || isForbiddenHost(host)) continue;
        if (haveHost.has(host)) continue;
        if (listing.payTo && (havePayTo.has(listing.payTo) || isForbiddenPayTo(listing.payTo))) {
          continue;
        }
        inspected += 1;
        const row = await consider(url, "hop");
        if (row.status === "not_402" || row.status === "no_payto" || row.status === "forbidden") {
          continue;
        }
        rows.push(row);
        hopped = true;
        // One hop: the first extra live 402 that the gate actually scored.
        break;
      }
      if (!hopped) {
        rows.push({
          role: "hop",
          resource_url: "",
          host: null,
          pay_to: null,
          network: null,
          price_usdc: null,
          http_status: null,
          decision: null,
          approved: false,
          reason: "no_eligible_hop",
          wash_flagged: null,
          status: "probe_error",
          abort: false,
        });
      }
    } catch (err) {
      rows.push({
        role: "hop",
        resource_url: "",
        host: null,
        pay_to: null,
        network: null,
        price_usdc: null,
        http_status: null,
        decision: null,
        approved: false,
        reason: err instanceof Error ? err.message : String(err),
        wash_flagged: null,
        status: "probe_error",
        abort: false,
      });
    }
  }

  const policy = buildPolicy({
    maxPerCallUsdc: args.maxPerCallUsdc,
    maxPerDayUsdc: args.maxPerDayUsdc,
    hosts: rows,
  });
  writeFile(args.policyOut, `${JSON.stringify(policy, null, 2)}\n`);

  const transcript: ColdStartTranscript = {
    schema: COLD_START_TRANSCRIPT_SCHEMA,
    package: "twzrd-x402-gate",
    packageVersion: CLIENT_VERSION,
    mode: "no_spend",
    integration: args.integration,
    runId: args.runId,
    lineage,
    clientHeader: `twzrd-x402-gate/${CLIENT_VERSION}`,
    autogate: {
      wired: true,
      refuseWashFlagged: true,
      install: AUTOGATE_INSTALL_SNIPPET,
    },
    signer_invocation_count: 0,
    payment_retry_count: 0,
    usdc_spent: 0,
    diet_urls: args.dietUrls,
    hop: args.hop,
    hosts: rows,
    allowlisted_count: policy.hosts.length,
    policy,
    policy_path: args.policyOut,
    exportedAt,
    notExternalRunProof: [...NOT_EXTERNAL],
    ok: true,
  };
  transcript.ok =
    transcript.signer_invocation_count === 0 &&
    transcript.usdc_spent === 0 &&
    transcript.autogate.wired === true &&
    transcript.mode === "no_spend";

  if (args.out) {
    writeFile(args.out, `${JSON.stringify(transcript, null, 2)}\n`);
  }

  return { transcript, policy, exitCode: 0 };
}
