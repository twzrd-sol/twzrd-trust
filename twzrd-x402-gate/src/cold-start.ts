/**
 * Cold-start buyer loop — no spend.
 *
 * Probe a pinned foreign x402 diet, score each payTo with evaluate_x402_resource
 * (same policy AutoGate uses), write a default-deny policy.json, hop once from
 * the resource join. Never pays. Never lists a TWZRD-operated seller as diet.
 * Seat AutoGate on the real payer with the snippet on the transcript.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { resolveLineage, type GateAdoptionLineage } from "./adoption-proof.js";
import { listDirectoryCallables } from "./directory.js";
import { evaluate_x402_resource } from "./evaluate.js";
import {
  payToFromRequirements,
  paymentRequiredFromResponse,
  pickRequirements,
  priceUsdcFromAmountMicro,
  type RequirementFieldConflict,
} from "./payto.js";
import { hasForbiddenResolution, type HostResolver } from "./ssrf.js";
import type { X402PaymentRequirements } from "./types.js";
import { CLIENT_VERSION } from "./version.js";

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
const HOP_INSPECT_CAP = 8;

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

  Probe a pinned foreign x402 diet (not *.twzrd), score each payTo with
  evaluate_x402_resource (wash refuse), write a default-deny policy.json, then hop
  once from GET /v1/intel/resources. Default is no spend. --spend is refused.
  Seat AutoGate on the payer with the snippet on the transcript.

  Exit 0: at least one diet host scored (allowlisted|refused|over_cap).
  Exit 1: no diet host scored a 402. Exit 2: bad invocation.
  Self-serve is dogfood, not EXTERNAL_RUN.`;

export type ColdStartHostStatus =
  | "allowlisted"
  | "refused"
  | "over_cap"
  | "not_402"
  | "no_payto"
  | "forbidden"
  | "probe_error"
  | "no_eligible_hop"
  | "directory_error";

const SCORED: ReadonlySet<ColdStartHostStatus> = new Set([
  "allowlisted",
  "refused",
  "over_cap",
]);

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
  /** Advisory for the payer; this CLI does not enforce a daily cap. */
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
  /** True when at least one diet or hop host was scored (allowlisted|refused|over_cap). */
  ok: boolean;
  /** Non-null when writing --policy-out failed; the transcript is still returned. */
  policy_write_error: string | null;
  /** Non-null when writing --out failed; the transcript is still returned. */
  transcript_write_error: string | null;
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

/** Same 15s bound as bounty-preflight-cli.ts. */
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
  if (isForbiddenHost(hostnameOf(url))) return true;
  if (u.pathname.includes("/v1/intel/refuse-fixture")) return true;
  return false;
}

export function isForbiddenPayTo(payTo: string | null | undefined): boolean {
  return payTo === REFUSE_FIXTURE_PAYTO;
}

/** Resolve aliases even when the output file itself does not exist yet. */
function canonicalOutputPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return join(canonicalOutputPath(parent), basename(absolute));
}

function validateOutputPaths(policyOut: string, out: string | null): void {
  if (out === null) return;
  const policyPath = canonicalOutputPath(policyOut);
  const transcriptPath = canonicalOutputPath(out);
  let sameFile = policyPath === transcriptPath;
  if (!sameFile && existsSync(policyPath) && existsSync(transcriptPath)) {
    const policyStat = statSync(policyPath);
    const transcriptStat = statSync(transcriptPath);
    sameFile = policyStat.dev === transcriptStat.dev && policyStat.ino === transcriptStat.ino;
  }
  if (sameFile) throw new Error("--out and --policy-out must refer to different files");
}

/**
 * Write an output artifact without letting a bad path (empty string, missing
 * parent directory, permissions) throw away an already-completed probe
 * transcript. On failure, the error is returned (never thrown) and the
 * content that would have been written is dumped to stderr as a fallback so
 * it is not silently lost.
 */
function writeOutputFile(path: string, content: string, label: string): string | null {
  try {
    writeFileSync(path, content);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `twzrd-cold-start: failed to write ${label} to ${JSON.stringify(path)}: ${message}`,
    );
    console.error(content);
    return message;
  }
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
  const policyOut = flags.get("--policy-out") ?? "policy.json";
  const out = flags.get("--out") ?? null;
  validateOutputPaths(policyOut, out);
  return {
    dietUrls: dietUrls.length > 0 ? dietUrls : [...DEFAULT_COLD_START_DIET],
    hop: !switches.has("--no-hop"),
    integration: flags.get("--integration") ?? "demo-cold-start",
    runId: flags.get("--run-id") ?? randomUUID(),
    policyOut,
    out,
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

function hostRow(
  role: "diet" | "hop",
  resourceUrl: string,
  extra: Partial<Omit<ColdStartHostRow, "role" | "resource_url">> &
    Pick<ColdStartHostRow, "status" | "reason">,
): ColdStartHostRow {
  const status = extra.status;
  const abort =
    extra.abort ?? (status === "forbidden" || status === "refused");
  return {
    role,
    resource_url: resourceUrl,
    host: extra.host !== undefined ? extra.host : hostnameOf(resourceUrl),
    pay_to: extra.pay_to ?? null,
    network: extra.network ?? null,
    price_usdc: extra.price_usdc ?? null,
    http_status: extra.http_status ?? null,
    decision: extra.decision ?? null,
    approved: extra.approved ?? false,
    reason: extra.reason,
    wash_flagged: extra.wash_flagged ?? null,
    status,
    abort,
  };
}

async function probeUnpaid402(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{
  httpStatus: number;
  req: X402PaymentRequirements;
  payTo: string | undefined;
  amountMicro: string | undefined;
  error: "not_402" | "no_payto" | RequirementFieldConflict | null;
}> {
  const resp = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (resp.status !== 402) {
    return { httpStatus: resp.status, req: {}, payTo: undefined, amountMicro: undefined, error: "not_402" };
  }
  const challenge = await paymentRequiredFromResponse(resp);
  const req = pickRequirements(challenge?.accepts);
  const { payTo, amountMicro, conflict } = payToFromRequirements(req);
  if (conflict) {
    return { httpStatus: 402, req, payTo, amountMicro, error: conflict };
  }
  if (!payTo) {
    return { httpStatus: 402, req, payTo: undefined, amountMicro, error: "no_payto" };
  }
  return { httpStatus: 402, req, payTo, amountMicro, error: null };
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
    if (row.price_usdc == null || !Number.isFinite(row.price_usdc) ||
        row.price_usdc < 0 || row.price_usdc > input.maxPerCallUsdc) continue;
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

export type ColdStartDeps = {
  /** Injectable for tests; defaults to a real DNS lookup. Never used to skip the check. */
  resolveHost?: HostResolver;
};

export async function runColdStart(
  args: ColdStartArgs,
  deps: ColdStartDeps = {},
): Promise<{ transcript: ColdStartTranscript; policy: ColdStartPolicy; exitCode: 0 | 1 }> {
  validateOutputPaths(args.policyOut, args.out);
  const fetchBound = withTimeout(globalThis.fetch);
  const exportedAt = new Date().toISOString();
  const lineage = resolveLineage(args.integration);

  async function consider(url: string, role: "diet" | "hop"): Promise<ColdStartHostRow> {
    if (isForbiddenUrl(url)) {
      return hostRow(role, url, { status: "forbidden", reason: "forbidden_twzrd_or_loopback" });
    }
    // Directory-listed hop candidates (and any diet URL) are third-party-controlled
    // hostnames: block private/loopback/link-local literals and DNS-rebound targets
    // before the real probe fetch, not just the twzrd/loopback hostname strings above.
    if (await hasForbiddenResolution(url, deps.resolveHost)) {
      return hostRow(role, url, { status: "forbidden", reason: "forbidden_private_resolution" });
    }
    try {
      const probed = await probeUnpaid402(url, fetchBound);
      if (probed.error === "not_402") {
        return hostRow(role, url, {
          status: "not_402",
          reason: "not_402",
          http_status: probed.httpStatus,
          abort: false,
        });
      }
      const parsedPrice = typeof probed.amountMicro === "string" && /^\d+$/.test(probed.amountMicro)
        ? priceUsdcFromAmountMicro(probed.amountMicro)
        : undefined;
      const price = parsedPrice != null && parsedPrice >= 0 ? parsedPrice : null;
      const network = probed.req.network ?? null;
      if (probed.error === "no_payto" || !probed.payTo) {
        return hostRow(role, url, {
          status: "no_payto",
          reason: "no_payto",
          network,
          price_usdc: price,
          http_status: probed.httpStatus,
          abort: false,
        });
      }
      if (isForbiddenPayTo(probed.payTo)) {
        return hostRow(role, url, {
          status: "forbidden",
          reason: "forbidden_refuse_fixture_payto",
          pay_to: probed.payTo,
          network,
          price_usdc: price,
          http_status: probed.httpStatus,
        });
      }
      if (price === null) {
        return hostRow(role, url, {
          status: "refused",
          reason: "price_unknown",
          pay_to: probed.payTo,
          network,
          http_status: probed.httpStatus,
        });
      }
      const gated = await evaluate_x402_resource(url, probed.req, {
        gateOnCanSpend: false,
        refuseWashFlagged: true,
        failOpen: false,
        intelBase: args.intelBase,
        fetch: fetchBound,
        attribution: { integration: args.integration, runId: args.runId },
      });
      const washFlagged = gated.washFlagged ?? null;
      // evaluate_x402_resource may itself approve a wash-flagged seller under a
      // configured TWZRD_WASH_MAX_USDC cap (reason "twzrd_wash_capped_..."), but
      // cold-start's own policy is to always refuse wash_flagged. Overriding
      // approved without also rewriting the reason would leave a row where
      // status is "refused" yet the reason text asserts the payment was allowed.
      const washOverridden = gated.approved === true && washFlagged === true;
      const approved = gated.approved === true && washFlagged !== true;
      let status: ColdStartHostStatus = "refused";
      if (approved) {
        status = price > args.maxPerCallUsdc ? "over_cap" : "allowlisted";
      }
      const reason = washOverridden
        ? `cold_start_wash_flagged_refused (gate approved with: ${gated.reason})`
        : gated.reason;
      return hostRow(role, url, {
        status,
        reason,
        pay_to: probed.payTo,
        network,
        price_usdc: price,
        http_status: probed.httpStatus,
        decision: gated.decision,
        approved,
        wash_flagged: washFlagged,
        abort: !approved,
      });
    } catch (err) {
      return hostRow(role, url, {
        status: "probe_error",
        reason: err instanceof Error ? err.message : String(err),
        abort: false,
      });
    }
  }

  const rows: ColdStartHostRow[] = await Promise.all(
    args.dietUrls.map((url) => consider(url, "diet")),
  );

  if (args.hop) {
    const haveHost = new Set(rows.filter((r) => r.host).map((r) => r.host as string));
    const havePayTo = new Set(rows.filter((r) => r.pay_to).map((r) => r.pay_to as string));
    try {
      const listings = await listDirectoryCallables({
        intelBase: args.intelBase,
        fetch: fetchBound,
        limit: 20,
        live402Only: true,
      });
      let hopped = false;
      let inspected = 0;
      for (const listing of listings) {
        if (inspected >= HOP_INSPECT_CAP) break;
        const url = listing.resourceUrl;
        if (!url || isForbiddenUrl(url)) continue;
        const host = hostnameOf(url);
        if (!host || haveHost.has(host)) continue;
        if (listing.payTo && (havePayTo.has(listing.payTo) || isForbiddenPayTo(listing.payTo))) {
          continue;
        }
        inspected += 1;
        const row = await consider(url, "hop");
        if (row.status === "not_402" || row.status === "no_payto" || row.status === "forbidden") {
          continue;
        }
        // The listing-level dedup above only catches a duplicate payTo when the
        // directory entry itself carries one; a listing with a null/missing
        // payTo (legitimate per directory.ts) skips that check even when its
        // live-resolved wallet turns out to duplicate one already scored. Catch
        // that here, after the real probe resolved it, rather than recording
        // (and consuming the single hop slot on) a redundant policy entry.
        if (row.pay_to && havePayTo.has(row.pay_to)) {
          continue;
        }
        rows.push(row);
        hopped = true;
        break;
      }
      if (!hopped) {
        rows.push(
          hostRow("hop", "", {
            host: null,
            status: "no_eligible_hop",
            reason: "no_eligible_hop",
            abort: false,
          }),
        );
      }
    } catch (err) {
      rows.push(
        hostRow("hop", "", {
          host: null,
          status: "directory_error",
          reason: err instanceof Error ? err.message : String(err),
          abort: false,
        }),
      );
    }
  }

  const policy = buildPolicy({
    maxPerCallUsdc: args.maxPerCallUsdc,
    maxPerDayUsdc: args.maxPerDayUsdc,
    hosts: rows,
  });
  const policyWriteError = writeOutputFile(
    args.policyOut,
    `${JSON.stringify(policy, null, 2)}\n`,
    "policy",
  );

  // A caller of the exported API (runColdStart/ColdStartArgs) can pass an
  // empty dietUrls, bypassing the CLI's DEFAULT_COLD_START_DIET backfill; ok
  // must also credit a successful hop-scored host, not diet rows alone.
  const ok = rows.some(
    (r) => (r.role === "diet" || r.role === "hop") && SCORED.has(r.status),
  );
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
    policy_path: policyWriteError ? null : args.policyOut,
    exportedAt,
    notExternalRunProof: [...NOT_EXTERNAL],
    ok,
    policy_write_error: policyWriteError,
    transcript_write_error: null,
  };

  if (args.out) {
    // The written file cannot include the outcome of its own write, but the
    // returned in-memory transcript is patched below so a caller still sees it.
    transcript.transcript_write_error = writeOutputFile(
      args.out,
      `${JSON.stringify(transcript, null, 2)}\n`,
      "transcript",
    );
  }

  return { transcript, policy, exitCode: ok ? 0 : 1 };
}
