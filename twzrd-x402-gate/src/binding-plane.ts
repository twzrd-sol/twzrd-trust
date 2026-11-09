/**
 * Track 5 — Binding Plane (`twzrd.binding_policy.v1` + `.kill` / `.pause` sentinels).
 *
 * Two enforcers (`agent-killswitch` compute proxy and `twzrd-x402-gate` payment
 * gate), one policy envelope, file-based backpressure sentinels, no shared
 * process or IPC socket.
 *
 * Sentinel rules:
 * - `.kill`: operator halt. Presence (or stat error) immediately blocks both
 *   planes (`403 kill_switch` in compute, `twzrd_kill_switch` in payment).
 * - `.pause`: payment-gate backpressure (`twzrd.pause_sentinel.v1`). Carries
 *   `until_unix_ms`, `reason`, and optional `decision_id`.
 *   - Missing (`ENOENT`): not paused.
 *   - Corrupt / unreadable / non-JSON / invalid `until_unix_ms`: fail closed
 *     (`paused: true, corrupt: true`).
 *   - Active (`now < until_unix_ms`): blocks both planes (`429 payment_gate_halt`
 *     in compute, `twzrd_payment_paused` in payment).
 *   - Expired (`now >= until_unix_ms`): not paused; readers allow without
 *     mutating disk.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { SpendControlOptions } from "./spend-control.js";
import type { TwzrdGateConfig } from "./types.js";

export const BINDING_POLICY_SCHEMA = "twzrd.binding_policy.v1" as const;
export const PAUSE_SENTINEL_SCHEMA = "twzrd.pause_sentinel.v1" as const;

export type BindingComputePolicyV1 = {
  upstream_base_url?: string;
  api_key_env?: string;
  timeout_ms?: number;
  free_models?: string[];
  max_tokens_per_minute?: number;
  max_usd_per_hour?: number;
  max_usd_per_day?: number;
  max_cost_per_request_usd?: number;
  enable_kill_api?: boolean;
  ledger_path?: string;
  port?: number;
};

export type BindingPaymentPolicyV1 = {
  intel_base?: string;
  max_spend_usdc?: string;
  allow_networks?: string[];
  preflight_min_score?: number;
  fail_open?: boolean;
  gate_on_can_spend?: boolean;
  refuse_unevaluated?: boolean;
  refuse_uncapped_warn?: boolean;
  intel_timeout_ms?: number;
  refuse_wash_flagged?: boolean;
  refuse_wash_unknown?: boolean;
  wash_max_usdc?: number;
  unsupported_network_mode?: "observe" | "strict";
  require_offer_binding?: boolean;
  require_decision_bind?: boolean;
  trip_pause_on_block_ms?: number;
  ledger_file?: string;
};

export type BindingPolicyV1 = {
  schema: typeof BINDING_POLICY_SCHEMA;
  state_dir?: string;
  compute?: BindingComputePolicyV1;
  payment?: BindingPaymentPolicyV1;
};

export type PauseSentinelV1 = {
  schema: typeof PAUSE_SENTINEL_SCHEMA;
  until_unix_ms: number;
  reason: string;
  decision_id?: string;
};

export type PauseSwitchState = {
  paused: boolean;
  corrupt: boolean;
  expired: boolean;
  untilUnixMs: number | null;
  reason: string | null;
  decisionId: string | null;
};

export type SentinelState =
  | { active: false; expiredPause?: boolean }
  | {
      active: true;
      mode: "kill" | "pause" | "corrupt_pause";
      reason: string;
      untilUnixMs: number | null;
      decisionId: string | null;
    };

const TOP_KEYS = new Set(["schema", "state_dir", "compute", "payment"]);
const COMPUTE_KEYS = new Set([
  "upstream_base_url",
  "api_key_env",
  "timeout_ms",
  "free_models",
  "max_tokens_per_minute",
  "max_usd_per_hour",
  "max_usd_per_day",
  "max_cost_per_request_usd",
  "enable_kill_api",
  "ledger_path",
  "port",
]);
const PAYMENT_KEYS = new Set([
  "intel_base",
  "max_spend_usdc",
  "allow_networks",
  "preflight_min_score",
  "fail_open",
  "gate_on_can_spend",
  "refuse_unevaluated",
  "refuse_uncapped_warn",
  "intel_timeout_ms",
  "refuse_wash_flagged",
  "refuse_wash_unknown",
  "wash_max_usdc",
  "unsupported_network_mode",
  "require_offer_binding",
  "require_decision_bind",
  "trip_pause_on_block_ms",
  "ledger_file",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function assertNonNegNum(val: unknown, label: string): number | undefined {
  if (val === undefined) return undefined;
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
    throw new Error(`[twzrd] invalid ${label}: must be a finite number >= 0`);
  }
  return val;
}

function assertBool(val: unknown, label: string): boolean | undefined {
  if (val === undefined) return undefined;
  if (typeof val !== "boolean") {
    throw new Error(`[twzrd] invalid ${label}: must be a boolean`);
  }
  return val;
}

function assertNonEmptyStr(val: unknown, label: string): string | undefined {
  if (val === undefined) return undefined;
  if (typeof val !== "string" || val.trim() === "") {
    throw new Error(`[twzrd] invalid ${label}: must be a non-empty string`);
  }
  return val.trim();
}

function assertStringArray(val: unknown, label: string): string[] | undefined {
  if (val === undefined) return undefined;
  if (!Array.isArray(val) || !val.every((x) => typeof x === "string" && x.trim().length > 0)) {
    throw new Error(`[twzrd] invalid ${label}: must be an array of non-empty strings`);
  }
  return val.map((x) => x.trim());
}

function validateComputeSection(raw: unknown): BindingComputePolicyV1 | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error("[twzrd] invalid compute section: must be an object");
  }
  for (const k of Object.keys(raw)) {
    if (!COMPUTE_KEYS.has(k)) {
      throw new Error(`[twzrd] unknown compute key '${k}' in ${BINDING_POLICY_SCHEMA}`);
    }
  }
  return {
    upstream_base_url: assertNonEmptyStr(raw.upstream_base_url, "compute.upstream_base_url"),
    api_key_env: assertNonEmptyStr(raw.api_key_env, "compute.api_key_env"),
    timeout_ms: assertNonNegNum(raw.timeout_ms, "compute.timeout_ms"),
    free_models: assertStringArray(raw.free_models, "compute.free_models"),
    max_tokens_per_minute: assertNonNegNum(raw.max_tokens_per_minute, "compute.max_tokens_per_minute"),
    max_usd_per_hour: assertNonNegNum(raw.max_usd_per_hour, "compute.max_usd_per_hour"),
    max_usd_per_day: assertNonNegNum(raw.max_usd_per_day, "compute.max_usd_per_day"),
    max_cost_per_request_usd: assertNonNegNum(
      raw.max_cost_per_request_usd,
      "compute.max_cost_per_request_usd",
    ),
    enable_kill_api: assertBool(raw.enable_kill_api, "compute.enable_kill_api"),
    ledger_path: assertNonEmptyStr(raw.ledger_path, "compute.ledger_path"),
    port: assertNonNegNum(raw.port, "compute.port"),
  };
}

function validatePaymentSection(raw: unknown): BindingPaymentPolicyV1 | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error("[twzrd] invalid payment section: must be an object");
  }
  for (const k of Object.keys(raw)) {
    if (!PAYMENT_KEYS.has(k)) {
      throw new Error(`[twzrd] unknown payment key '${k}' in ${BINDING_POLICY_SCHEMA}`);
    }
  }
  const maxSpend = assertNonEmptyStr(raw.max_spend_usdc, "payment.max_spend_usdc");
  if (maxSpend !== undefined && !/^\d+(?:\.\d{1,6})?$/.test(maxSpend)) {
    throw new Error(
      `[twzrd] invalid payment.max_spend_usdc '${maxSpend}': must be a non-negative decimal USD string (up to 6 decimals)`,
    );
  }
  let mode: "observe" | "strict" | undefined;
  if (raw.unsupported_network_mode !== undefined) {
    if (raw.unsupported_network_mode !== "observe" && raw.unsupported_network_mode !== "strict") {
      throw new Error(
        `[twzrd] invalid payment.unsupported_network_mode: must be 'observe' or 'strict'`,
      );
    }
    mode = raw.unsupported_network_mode;
  }
  return {
    intel_base: assertNonEmptyStr(raw.intel_base, "payment.intel_base"),
    max_spend_usdc: maxSpend,
    allow_networks: assertStringArray(raw.allow_networks, "payment.allow_networks"),
    preflight_min_score: assertNonNegNum(raw.preflight_min_score, "payment.preflight_min_score"),
    fail_open: assertBool(raw.fail_open, "payment.fail_open"),
    gate_on_can_spend: assertBool(raw.gate_on_can_spend, "payment.gate_on_can_spend"),
    refuse_unevaluated: assertBool(raw.refuse_unevaluated, "payment.refuse_unevaluated"),
    refuse_uncapped_warn: assertBool(raw.refuse_uncapped_warn, "payment.refuse_uncapped_warn"),
    intel_timeout_ms: assertNonNegNum(raw.intel_timeout_ms, "payment.intel_timeout_ms"),
    refuse_wash_flagged: assertBool(raw.refuse_wash_flagged, "payment.refuse_wash_flagged"),
    refuse_wash_unknown: assertBool(raw.refuse_wash_unknown, "payment.refuse_wash_unknown"),
    wash_max_usdc: assertNonNegNum(raw.wash_max_usdc, "payment.wash_max_usdc"),
    unsupported_network_mode: mode,
    require_offer_binding: assertBool(raw.require_offer_binding, "payment.require_offer_binding"),
    require_decision_bind: assertBool(raw.require_decision_bind, "payment.require_decision_bind"),
    trip_pause_on_block_ms: assertNonNegNum(
      raw.trip_pause_on_block_ms,
      "payment.trip_pause_on_block_ms",
    ),
    ledger_file: assertNonEmptyStr(raw.ledger_file, "payment.ledger_file"),
  };
}

/**
 * Parse and validate a `twzrd.binding_policy.v1` envelope.
 *
 * By default (`section: "all"`), both `compute` and `payment` sections are
 * validated fail-closed. Passing `section: "compute"` or `section: "payment"`
 * validates only that reader's section (plus top-level keys and `state_dir`),
 * so a misconfiguration in the sibling section does not take down this reader.
 */
export function parseBindingPolicy(
  raw: unknown,
  options: { section?: "all" | "compute" | "payment" } = {},
): BindingPolicyV1 {
  if (!isPlainObject(raw)) {
    throw new Error(`[twzrd] binding policy must be a JSON/YAML object`);
  }
  if (raw.schema !== BINDING_POLICY_SCHEMA) {
    throw new Error(
      `[twzrd] binding policy schema must be '${BINDING_POLICY_SCHEMA}' (got ${JSON.stringify(raw.schema)})`,
    );
  }
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) {
      throw new Error(`[twzrd] unknown top-level key '${k}' in ${BINDING_POLICY_SCHEMA}`);
    }
  }
  const stateDir = assertNonEmptyStr(raw.state_dir, "state_dir");
  const section = options.section ?? "all";
  const compute =
    section === "all" || section === "compute" ? validateComputeSection(raw.compute) : undefined;
  const payment =
    section === "all" || section === "payment" ? validatePaymentSection(raw.payment) : undefined;

  return {
    schema: BINDING_POLICY_SCHEMA,
    ...(stateDir !== undefined ? { state_dir: stateDir } : {}),
    ...(compute !== undefined ? { compute } : {}),
    ...(payment !== undefined ? { payment } : {}),
  };
}

export function bindingPolicyToGateConfig(
  policy: BindingPolicyV1,
  baseDir = process.cwd(),
): TwzrdGateConfig {
  const stateDir = path.resolve(baseDir, policy.state_dir ?? "./data");
  const p = policy.payment ?? {};
  return {
    stateDir,
    killFilePath: path.join(stateDir, ".kill"),
    pauseFilePath: path.join(stateDir, ".pause"),
    ...(p.intel_base !== undefined ? { intelBase: p.intel_base } : {}),
    ...(p.preflight_min_score !== undefined ? { preflightMinScore: p.preflight_min_score } : {}),
    ...(p.fail_open !== undefined ? { failOpen: p.fail_open } : {}),
    ...(p.gate_on_can_spend !== undefined ? { gateOnCanSpend: p.gate_on_can_spend } : {}),
    ...(p.refuse_unevaluated !== undefined ? { refuseUnevaluated: p.refuse_unevaluated } : {}),
    ...(p.refuse_uncapped_warn !== undefined ? { refuseUncappedWarn: p.refuse_uncapped_warn } : {}),
    ...(p.intel_timeout_ms !== undefined ? { intelTimeoutMs: p.intel_timeout_ms } : {}),
    ...(p.refuse_wash_flagged !== undefined ? { refuseWashFlagged: p.refuse_wash_flagged } : {}),
    ...(p.refuse_wash_unknown !== undefined ? { refuseWashUnknown: p.refuse_wash_unknown } : {}),
    ...(p.wash_max_usdc !== undefined ? { washMaxUsdc: p.wash_max_usdc } : {}),
    ...(p.unsupported_network_mode !== undefined
      ? { unsupportedNetworkMode: p.unsupported_network_mode }
      : {}),
    ...(p.trip_pause_on_block_ms !== undefined
      ? { tripPauseOnBlockMs: p.trip_pause_on_block_ms }
      : {}),
  };
}

export function bindingPolicyToSpendControlOptions(
  policy: BindingPolicyV1,
  baseDir = process.cwd(),
): SpendControlOptions {
  const stateDir = path.resolve(baseDir, policy.state_dir ?? "./data");
  const p = policy.payment ?? {};
  return {
    stateDir,
    killFilePath: path.join(stateDir, ".kill"),
    pauseFilePath: path.join(stateDir, ".pause"),
    ledgerFile: p.ledger_file
      ? path.resolve(baseDir, p.ledger_file)
      : path.join(stateDir, "payment-spend-ledger.jsonl"),
    ...(p.max_spend_usdc !== undefined ? { maxSpend: p.max_spend_usdc } : {}),
    ...(p.allow_networks !== undefined ? { allowNetworks: [...p.allow_networks] } : {}),
    ...(p.require_offer_binding !== undefined
      ? { requireOfferBinding: p.require_offer_binding }
      : {}),
    ...(p.require_decision_bind !== undefined
      ? { requireDecisionBind: p.require_decision_bind }
      : {}),
    ...(p.trip_pause_on_block_ms !== undefined
      ? { tripPauseOnBlockMs: p.trip_pause_on_block_ms }
      : {}),
  };
}

/** Instant kill switch: presence of the file (or stat error) vetoes everything. */
export function checkKillSwitchFile(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

/**
 * Payment-gate backpressure sentinel (.pause).
 *
 * Fail-closed on any read/parse/schema error; active while `now < until_unix_ms`;
 * inactive once `now >= until_unix_ms`.
 */
export function checkPauseSwitchFile(filePath: string, now = Date.now()): PauseSwitchState {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        paused: false,
        corrupt: false,
        expired: false,
        untilUnixMs: null,
        reason: null,
        decisionId: null,
      };
    }
    return {
      paused: true,
      corrupt: true,
      expired: false,
      untilUnixMs: null,
      reason: "corrupt_pause_sentinel",
      decisionId: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      paused: true,
      corrupt: true,
      expired: false,
      untilUnixMs: null,
      reason: "corrupt_pause_sentinel",
      decisionId: null,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      paused: true,
      corrupt: true,
      expired: false,
      untilUnixMs: null,
      reason: "corrupt_pause_sentinel",
      decisionId: null,
    };
  }

  if ("schema" in parsed && parsed.schema !== PAUSE_SENTINEL_SCHEMA) {
    return {
      paused: true,
      corrupt: true,
      expired: false,
      untilUnixMs: null,
      reason: "corrupt_pause_sentinel",
      decisionId: null,
    };
  }

  const until = parsed.until_unix_ms;
  if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) {
    return {
      paused: true,
      corrupt: true,
      expired: false,
      untilUnixMs: null,
      reason: "corrupt_pause_sentinel",
      decisionId: null,
    };
  }

  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim().length > 0
      ? parsed.reason.trim()
      : null;
  const decisionId =
    typeof parsed.decision_id === "string" && parsed.decision_id.trim().length > 0
      ? parsed.decision_id.trim()
      : null;

  if (now < until) {
    return {
      paused: true,
      corrupt: false,
      expired: false,
      untilUnixMs: until,
      reason: reason ?? "payment_gate_halt",
      decisionId,
    };
  }

  return {
    paused: false,
    corrupt: false,
    expired: true,
    untilUnixMs: until,
    reason,
    decisionId,
  };
}

export function readSentinelState(opts: {
  stateDir?: string;
  killFilePath?: string;
  pauseFilePath?: string;
  now?: number;
}): SentinelState {
  const killPath =
    opts.killFilePath ?? (opts.stateDir ? path.join(opts.stateDir, ".kill") : undefined);
  const pausePath =
    opts.pauseFilePath ?? (opts.stateDir ? path.join(opts.stateDir, ".pause") : undefined);

  if (killPath && checkKillSwitchFile(killPath)) {
    return {
      active: true,
      mode: "kill",
      reason: "twzrd_kill_switch",
      untilUnixMs: null,
      decisionId: null,
    };
  }

  if (pausePath) {
    const p = checkPauseSwitchFile(pausePath, opts.now);
    if (p.paused) {
      return {
        active: true,
        mode: p.corrupt ? "corrupt_pause" : "pause",
        reason: p.corrupt ? "twzrd_pause_corrupt" : (p.reason ?? "payment_gate_halt"),
        untilUnixMs: p.untilUnixMs,
        decisionId: p.decisionId,
      };
    }
    if (p.expired) {
      return { active: false, expiredPause: true };
    }
  }

  return { active: false };
}

/**
 * Atomically write a `.pause` sentinel (write + fsync temp file, then rename)
 * so concurrent compute/payment readers never observe a torn JSON file.
 */
export function writePauseSentinel(
  filePath: string,
  input: { ttlMs: number; reason: string; decisionId?: string; now?: number },
): PauseSentinelV1 {
  if (typeof input.ttlMs !== "number" || !Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error(`[twzrd] writePauseSentinel: ttlMs must be a positive finite number`);
  }
  const reason = String(input.reason ?? "").trim() || "payment_gate_halt";
  const now = input.now ?? Date.now();
  const payload: PauseSentinelV1 = {
    schema: PAUSE_SENTINEL_SCHEMA,
    until_unix_ms: Math.floor(now + input.ttlMs),
    reason,
    ...(input.decisionId ? { decision_id: input.decisionId } : {}),
  };
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${now}.tmp`;
  const fd = fs.openSync(tmpPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(payload) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  return payload;
}
