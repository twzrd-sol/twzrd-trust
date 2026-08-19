/**
 * twzrd-safe-fetch — experimental AgentCash **pre-invocation** preflight.
 *
 * SECURITY CLASSIFICATION: **advisory_precheck** (not a challenge-bound firewall).
 *
 * AgentCash CLI consumes HTTP 402 internally. This process can only:
 *
 *   1. RAW probe → observe challenge A
 *   2. TWZRD preflight on A
 *   3. If policy allows → shell out to AgentCash, which makes a **second** request
 *      and may receive challenge B ≠ A, then signs B without TWZRD re-check
 *
 * TOCTOU: recipient, network, asset, or amount can change between probe and pay.
 * `requirement_scored_matches_requirement_signed` is always false for this adapter
 * until AgentCash exposes an onPaymentRequested hook that binds the exact requirement.
 *
 * Secure paths:
 *   - installTwzrdAutoGate over raw fetch + injectible pay client
 *   - twzrdOnPaymentRequested MCP hook
 *
 * Never wrap agentcash fetch with withTwzrdGuard — that is too late.
 * Do not market this CLI as a secure AgentCash firewall.
 */

import { spawn } from "node:child_process";

import { resolveConfig } from "./config.js";
import {
  captureDeliveryObservation,
  type DeliveryCaptureResult,
} from "./delivery-capture.js";
import {
  amountBucket,
  classifyNetwork,
} from "./network.js";
import {
  payToFromRequirements,
  pickRequirements,
  priceUsdcFromAmountMicro,
} from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";
import type { TwzrdApprovalResult, X402PaymentRequiredBody } from "./types.js";

export type SafeFetchOptions = {
  url: string;
  method?: string;
  body?: string;
  headers?: string[];
  /** Prefer payment network for AgentCash (e.g. solana) */
  paymentNetwork?: string;
  gateOnCanSpend?: boolean;
  unsupportedNetworkMode?: "observe" | "strict";
  failOpen?: boolean;
  refuseWashFlagged?: boolean;
  preflightMinScore?: number;
  intelBase?: string;
  /** If true, stop after preflight; never invoke AgentCash */
  dryRun?: boolean;
  /** Skip AgentCash; only raw+preflight (alias dryRun for clarity in some UIs) */
  preflightOnly?: boolean;
  /** AgentCash package for npx (default agentcash@latest) */
  agentcashPackage?: string;
  /** Extra args after `fetch <url>` */
  agentcashExtraArgs?: string[];
  /**
   * Post-settle delivery observation capture (Phase 2 delivery-proof).
   * Default true; also disabled by TWZRD_DELIVERY_CAPTURE=0|false.
   */
  deliveryCapture?: boolean;
  /** Inject fetch for tests */
  fetch?: typeof fetch;
  /** Inject payer runner for tests */
  runPayer?: (args: {
    url: string;
    method: string;
    body?: string;
    headers: string[];
    paymentNetwork?: string;
  }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  onEvent?: (event: string, detail?: Record<string, unknown>) => void;
};

/** Snapshot of an x402 requirement used for TOCTOU / binding diagnostics. */
export type PaymentRequirementSnapshot = {
  payTo?: string;
  network?: string;
  amountMicro?: string;
  asset?: string;
  resource?: string;
};

export type SafeFetchResult = {
  ok: boolean;
  phase: "passthrough" | "blocked" | "dry_run_allowed" | "paid" | "payer_failed" | "error";
  initialStatus: number;
  payTo?: string;
  network?: string;
  amountMicro?: string;
  priceUsdc?: number;
  approval?: TwzrdApprovalResult;
  eventOrder: string[];
  payer?: { exitCode: number; stdout: string; stderr: string };
  error?: string;
  resourceStatus?: number;
  resourceBody?: unknown;
  /**
   * Requirement TWZRD preflighted from the probe 402.
   * For the AgentCash CLI path this is NOT proven equal to what AgentCash signed.
   */
  requirementScored?: PaymentRequirementSnapshot;
  /**
   * Requirement AgentCash signed — only populated if the payer reports it.
   * AgentCash CLI stdout typically does not expose this; then remains undefined.
   */
  requirementSigned?: PaymentRequirementSnapshot;
  /**
   * Always false for the shell-out AgentCash adapter (two independent HTTP requests).
   * True only if a future challenge-bound integration proves equality.
   */
  requirementScoredMatchesRequirementSigned: boolean;
  /**
   * How many HTTP requests hit the *target* resource during this execution.
   * Advisory path: 1 (blocked/dry-run) or 2+ (probe + AgentCash re-fetch).
   */
  targetRequestCount: number;
  /** Security classification of this adapter */
  cliSecurityClassification: "advisory_precheck";
  /**
   * Post-settle delivery observation (paid phase only). posted=false when
   * capture is disabled or the collector endpoint is unreachable; the
   * observation itself is still returned for local transcripts.
   */
  deliveryCapture?: DeliveryCaptureResult;
};

function emit(
  opts: SafeFetchOptions,
  order: string[],
  event: string,
  detail?: Record<string, unknown>,
) {
  order.push(event);
  opts.onEvent?.(event, detail);
}

function parseHeaderFlags(headers: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const i = h.indexOf(":");
    if (i <= 0) continue;
    out[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return out;
}

export async function runAgentcashFetch(args: {
  url: string;
  method: string;
  body?: string;
  headers: string[];
  paymentNetwork?: string;
  agentcashPackage?: string;
  extraArgs?: string[];
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const pkg = args.agentcashPackage ?? "agentcash@latest";
  const cmdArgs = [
    "-y",
    pkg,
    "fetch",
    args.url,
    "-y",
    "--format",
    "json",
    "-m",
    args.method,
  ];
  if (args.body != null) {
    cmdArgs.push("-b", args.body);
  }
  for (const h of args.headers) {
    cmdArgs.push("-H", h);
  }
  if (args.paymentNetwork) {
    cmdArgs.push("--payment-network", args.paymentNetwork);
  }
  if (args.extraArgs?.length) {
    cmdArgs.push(...args.extraArgs);
  }

  return new Promise((resolve) => {
    const child = spawn("npx", cmdArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + String(err.message ?? err),
      });
    });
  });
}

/**
 * Core safe-fetch pipeline (library + CLI).
 */
export async function safeFetch(opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const eventOrder: string[] = [];
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const method = (opts.method ?? "GET").toUpperCase();
  const headers = parseHeaderFlags(opts.headers);
  if (opts.body != null && !headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json";
  }

  emit(opts, eventOrder, "raw_request_start", { url: opts.url, method });

  let rawResp: Response;
  try {
    rawResp = await fetchFn(opts.url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : opts.body,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit(opts, eventOrder, "raw_request_error", { error: msg });
    return {
      ok: false,
      phase: "error",
      initialStatus: 0,
      eventOrder,
      error: msg,
      requirementScoredMatchesRequirementSigned: false,
      targetRequestCount: 0,
      cliSecurityClassification: "advisory_precheck",
    };
  }

  emit(opts, eventOrder, "raw_response", { status: rawResp.status });

  if (rawResp.status !== 402) {
    let resourceBody: unknown;
    const ct = rawResp.headers.get("content-type") ?? "";
    try {
      resourceBody = ct.includes("json")
        ? await rawResp.json()
        : await rawResp.text();
    } catch {
      resourceBody = null;
    }
    emit(opts, eventOrder, "passthrough_non_402");
    return {
      ok: rawResp.ok,
      phase: "passthrough",
      initialStatus: rawResp.status,
      eventOrder,
      resourceStatus: rawResp.status,
      resourceBody,
      requirementScoredMatchesRequirementSigned: false,
      targetRequestCount: 1,
      cliSecurityClassification: "advisory_precheck",
    };
  }

  let body: X402PaymentRequiredBody = {};
  try {
    body = (await rawResp.clone().json()) as X402PaymentRequiredBody;
  } catch {
    emit(opts, eventOrder, "malformed_402");
    return {
      ok: false,
      phase: "error",
      initialStatus: 402,
      eventOrder,
      error: "malformed_402_body",
      requirementScoredMatchesRequirementSigned: false,
      targetRequestCount: 1,
      cliSecurityClassification: "advisory_precheck",
    };
  }

  const first = pickRequirements(body.accepts as Array<Record<string, unknown>> | undefined);
  const { payTo, amountMicro, resource } = payToFromRequirements(first);
  const priceUsdc = priceUsdcFromAmountMicro(amountMicro);
  const network = first.network;
  const netCls = classifyNetwork(network, payTo);

  emit(opts, eventOrder, "initial_402_receipt", {
    payTo,
    network,
    amountMicro,
    priceUsdc,
    networkKind: netCls.kind,
    reputationScored: netCls.reputationScored,
    n_accepts: (body.accepts ?? []).length,
  });

  const requirementScored: PaymentRequirementSnapshot = {
    payTo,
    network,
    amountMicro,
    asset: typeof first.asset === "string" ? first.asset : undefined,
    resource: resource ?? opts.url,
  };

  if (!payTo) {
    emit(opts, eventOrder, "malformed_402_no_payto");
    return {
      ok: false,
      phase: "blocked",
      initialStatus: 402,
      eventOrder,
      error: "malformed_402_no_payto",
      network,
      amountMicro,
      priceUsdc,
      requirementScored,
      requirementScoredMatchesRequirementSigned: false,
      targetRequestCount: 1,
      cliSecurityClassification: "advisory_precheck",
    };
  }

  const cfg = resolveConfig({
    intelBase: opts.intelBase,
    gateOnCanSpend: opts.gateOnCanSpend,
    unsupportedNetworkMode: opts.unsupportedNetworkMode,
    failOpen: opts.failOpen,
    refuseWashFlagged: opts.refuseWashFlagged,
    preflightMinScore: opts.preflightMinScore,
    fetch: fetchFn,
  });

  emit(opts, eventOrder, "twzrd_preflight_start", {
    payTo,
    network,
    amount_bucket: amountBucket(amountMicro),
  });

  const approval = await twzrdApprovePayment(
    {
      resourceUrl: resource ?? opts.url,
      payTo,
      priceUsdc,
      agentIntent: "twzrd_safe_fetch",
      chain: network,
    },
    cfg,
  );

  emit(opts, eventOrder, "twzrd_preflight_result", {
    approved: approval.approved,
    verdict: approval.verdict,
    reason: approval.reason,
    score: approval.score,
    policyAction: approval.policyAction,
    reputationScored: approval.reputationScored,
    network: approval.network,
  });

  if (!approval.approved) {
    emit(opts, eventOrder, "payment_blocked", { reason: approval.reason });
    return {
      ok: false,
      phase: "blocked",
      initialStatus: 402,
      payTo,
      network,
      amountMicro,
      priceUsdc,
      approval,
      eventOrder,
      error: approval.reason,
      requirementScored,
      // No second request — nothing was signed
      requirementScoredMatchesRequirementSigned: false,
      targetRequestCount: 1,
      cliSecurityClassification: "advisory_precheck",
    };
  }

  const dry = opts.dryRun || opts.preflightOnly;
  if (dry) {
    emit(opts, eventOrder, "dry_run_stop_before_pay");
    return {
      ok: true,
      phase: "dry_run_allowed",
      initialStatus: 402,
      payTo,
      network,
      amountMicro,
      priceUsdc,
      approval,
      eventOrder,
      requirementScored,
      requirementScoredMatchesRequirementSigned: false,
      targetRequestCount: 1,
      cliSecurityClassification: "advisory_precheck",
    };
  }

  emit(opts, eventOrder, "payer_invoke_start", {
    client: "agentcash",
    paymentNetwork: opts.paymentNetwork,
  });

  const runPayer =
    opts.runPayer ??
    ((a) =>
      runAgentcashFetch({
        url: a.url,
        method: a.method,
        body: a.body,
        headers: a.headers,
        paymentNetwork: a.paymentNetwork,
        agentcashPackage: opts.agentcashPackage,
        extraArgs: opts.agentcashExtraArgs,
      }));

  const payerStartedAt = Date.now();
  const payer = await runPayer({
    url: opts.url,
    method,
    body: opts.body,
    headers: opts.headers ?? [],
    paymentNetwork: opts.paymentNetwork,
  });
  const payerLatencyMs = Date.now() - payerStartedAt;

  emit(opts, eventOrder, "payer_invoke_done", {
    exitCode: payer.exitCode,
    stdout_len: payer.stdout.length,
  });

  if (payer.exitCode !== 0) {
    return {
      ok: false,
      phase: "payer_failed",
      initialStatus: 402,
      payTo,
      network,
      amountMicro,
      priceUsdc,
      approval,
      eventOrder,
      payer,
      error: `agentcash_exit_${payer.exitCode}`,
      requirementScored,
      // AgentCash made its own request; we cannot prove signed === scored
      requirementScoredMatchesRequirementSigned: false,
      targetRequestCount: 2,
      cliSecurityClassification: "advisory_precheck",
    };
  }

  let resourceBody: unknown;
  try {
    resourceBody = JSON.parse(payer.stdout);
  } catch {
    resourceBody = payer.stdout;
  }

  // AgentCash CLI does not return the challenge it signed. Binding is unproven.
  emit(opts, eventOrder, "challenge_binding_unproven", {
    requirement_scored_matches_requirement_signed: false,
    note: "AgentCash CLI re-fetches the target; challenge may differ from probe",
  });

  // Post-settle delivery observation (Phase 2 delivery-proof): passive,
  // fire-and-forget, never throws into the pay path. Verdict is against the
  // merchant's own advertised output from the 402 challenge.
  const deliveryCapture = await captureDeliveryObservation(
    {
      merchantWallet: payTo,
      httpStatus: 200,
      resourceBody,
      challengeBody: body,
      payerOutput: resourceBody,
      latencyMs: payerLatencyMs,
      resource: resource ?? opts.url,
      network,
      enabled: opts.deliveryCapture,
    },
    cfg,
  );
  emit(opts, eventOrder, "delivery_observation", {
    posted: deliveryCapture.posted,
    schema_match: deliveryCapture.observation.schema_match,
    check_level: deliveryCapture.observation.check_level,
    has_settlement_tx: deliveryCapture.observation.settlement_tx != null,
  });

  return {
    ok: true,
    phase: "paid",
    initialStatus: 402,
    payTo,
    network,
    amountMicro,
    priceUsdc,
    approval,
    eventOrder,
    payer,
    resourceStatus: 200,
    resourceBody,
    requirementScored,
    requirementSigned: undefined,
    requirementScoredMatchesRequirementSigned: false,
    targetRequestCount: 2,
    cliSecurityClassification: "advisory_precheck",
    deliveryCapture,
  };
}

// --- CLI ---

function printHelp(): void {
  console.log(`twzrd-safe-fetch — EXPERIMENTAL advisory pre-check before AgentCash

SECURITY: advisory_precheck — NOT a challenge-bound firewall.

  Probe request 1 → TWZRD scores challenge A
  AgentCash request 2 → may receive challenge B ≠ A and signs B without re-check

  requirement_scored_matches_requirement_signed is always false for this tool.
  Prefer installTwzrdAutoGate (raw fetch + injectible pay client) or MCP
  onPaymentRequested for secure pre-sign binding.

Usage:
  twzrd-safe-fetch <url> [options]

Order:
  raw 402 → TWZRD preflight → (if allowed) shell out to agentcash fetch

Options:
  --method, -m <GET|POST|...>     HTTP method (default GET)
  --body, -b <json>               Request body
  --header, -H "Name: value"      Extra headers (repeatable)
  --payment-network <solana|...>  Passed to agentcash fetch
  --gate-on-can-spend             Block when preflight can_spend=false
  --unsupported-network-mode <observe|strict>
  --fail-open / --fail-closed     Preflight outage behavior (default closed)
  --no-wash-refuse                Disable wash_flagged refuse
  --dry-run                       Preflight only; never pay
  --json                          Machine-readable result on stdout
  --help                          Show this help

Examples:
  # Advisory block: AgentCash never invoked
  twzrd-safe-fetch https://example/paid --gate-on-can-spend --payment-network solana --json

  # Dry-run only
  twzrd-safe-fetch https://intel.twzrd.xyz/v1/intel/quick/<pubkey> --dry-run --json
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return argv.includes("--help") || argv.includes("-h") ? 0 : 1;
  }

  const url = argv.find((a) => !a.startsWith("-") && a.includes("://"));
  if (!url) {
    console.error("error: missing url");
    printHelp();
    return 1;
  }

  const getFlag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0 || i + 1 >= argv.length) return undefined;
    return argv[i + 1];
  };
  const has = (name: string) => argv.includes(name);

  const headers: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "-H" || argv[i] === "--header") && argv[i + 1]) {
      headers.push(argv[i + 1]!);
      i++;
    }
  }

  const jsonOut = has("--json");
  const result = await safeFetch({
    url,
    method: getFlag("-m") ?? getFlag("--method") ?? "GET",
    body: getFlag("-b") ?? getFlag("--body"),
    headers,
    paymentNetwork: getFlag("--payment-network"),
    gateOnCanSpend: has("--gate-on-can-spend"),
    unsupportedNetworkMode: (getFlag("--unsupported-network-mode") as
      | "observe"
      | "strict"
      | undefined),
    failOpen: has("--fail-open") ? true : has("--fail-closed") ? false : undefined,
    refuseWashFlagged: has("--no-wash-refuse") ? false : undefined,
    dryRun: has("--dry-run"),
    onEvent: jsonOut
      ? undefined
      : (event, detail) => {
          const d = detail ? ` ${JSON.stringify(detail)}` : "";
          console.error(`[twzrd-safe-fetch] ${event}${d}`);
        },
  });

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.phase === "paid" && result.payer?.stdout) {
    console.log(result.payer.stdout);
  } else if (result.phase === "passthrough") {
    console.log(
      typeof result.resourceBody === "string"
        ? result.resourceBody
        : JSON.stringify(result.resourceBody, null, 2),
    );
  } else if (result.phase === "dry_run_allowed") {
    console.error(
      `[twzrd-safe-fetch] dry-run allowed payTo=${result.payTo} reason=${result.approval?.reason}`,
    );
  } else if (!result.ok) {
    console.error(
      `[twzrd-safe-fetch] ${result.phase}: ${result.error ?? result.approval?.reason ?? "failed"}`,
    );
  }

  if (result.phase === "blocked") return 2;
  if (result.phase === "payer_failed" || result.phase === "error") return 1;
  if (result.phase === "passthrough" && !result.ok) return 1;
  return 0;
}

// ESM CLI entry when executed directly
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("safe-fetch.ts") ||
    process.argv[1].endsWith("safe-fetch.js") ||
    process.argv[1].includes("twzrd-safe-fetch"));

if (isMain) {
  main().then((code) => process.exit(code));
}
