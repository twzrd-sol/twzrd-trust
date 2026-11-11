import { parseModelRates, type ModelRates } from "./pricing.js";
import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";

export const BINDING_POLICY_SCHEMA = "twzrd.binding_policy.v1" as const;

export interface KillswitchConfig {
  upstreamBaseUrl: string;
  apiKey: string;
  /**
   * Exact upstream model ids that may be forwarded. Non-empty means this
   * process does not read or send an upstream API key: a model outside the
   * list is vetoed before the request leaves the machine.
   */
  freeModels: string[];
  modelRates: ModelRates;
  /** Milliseconds to wait for upstream response headers (and the whole body when not streaming). 0 disables. */
  upstreamTimeoutMs: number;
  maxTokensPerMinute: number;
  maxUsdPerHour: number;
  maxUsdPerDay: number;
  maxCostPerRequestUsd: number;
  killFilePath: string;
  pauseFilePath: string;
  enableKillApi: boolean;
  ledgerPath: string;
  port: number;
}

interface RawConfig {
  model_rates?: unknown;
  schema?: string;
  state_dir?: unknown;
  compute?: Record<string, unknown>;
  payment?: unknown;
  upstream?: { base_url?: string; api_key_env?: string; timeout_ms?: number };
  limits?: {
    max_tokens_per_minute?: number;
    max_usd_per_hour?: number;
    max_usd_per_day?: number;
    max_cost_per_request_usd?: number;
  };
  kill_switch?: { file_path?: string; pause_file_path?: string; enable_api_endpoint?: boolean };
  logging?: { path?: string };
  server?: { port?: number };
}

const BINDING_TOP_KEYS = new Set(["schema", "state_dir", "compute", "payment"]);
const BINDING_COMPUTE_KEYS = new Set([
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

function nonNegNum(val: unknown, name: string): number | undefined {
  if (val === undefined) return undefined;
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
    throw new Error(`Invalid numeric compute config '${name}': ${String(val)}`);
  }
  return val;
}

function validateBindingComputeSection(raw: Record<string, unknown>): {
  stateDir?: string;
  upstreamBaseUrl?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  freeModels?: string[];
  maxTokensPerMinute?: number;
  maxUsdPerHour?: number;
  maxUsdPerDay?: number;
  maxCostPerRequestUsd?: number;
  enableKillApi?: boolean;
  ledgerPath?: string;
  port?: number;
} {
  for (const k of Object.keys(raw)) {
    if (!BINDING_TOP_KEYS.has(k)) {
      throw new Error(`Unknown top-level key '${k}' in ${BINDING_POLICY_SCHEMA}`);
    }
  }
  let stateDir: string | undefined;
  if (raw["state_dir"] !== undefined) {
    if (typeof raw["state_dir"] !== "string" || raw["state_dir"].trim() === "") {
      throw new Error("Invalid state_dir in binding policy: must be a non-empty string");
    }
    stateDir = raw["state_dir"].trim();
  }
  const compRaw = raw["compute"];
  if (compRaw === undefined) return { stateDir };
  if (!compRaw || typeof compRaw !== "object" || Array.isArray(compRaw)) {
    throw new Error("Invalid compute section in binding policy: must be an object");
  }
  const c = compRaw as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (!BINDING_COMPUTE_KEYS.has(k)) {
      throw new Error(`Unknown compute key '${k}' in ${BINDING_POLICY_SCHEMA}`);
    }
  }
  if (c["upstream_base_url"] !== undefined && (typeof c["upstream_base_url"] !== "string" || !c["upstream_base_url"].trim())) {
    throw new Error("Invalid compute.upstream_base_url: must be a non-empty string");
  }
  if (c["api_key_env"] !== undefined && (typeof c["api_key_env"] !== "string" || !c["api_key_env"].trim())) {
    throw new Error("Invalid compute.api_key_env: must be a non-empty string");
  }
  let freeModels: string[] | undefined;
  if (c["free_models"] !== undefined) {
    if (!Array.isArray(c["free_models"]) || !c["free_models"].every((m) => typeof m === "string" && m.trim().length > 0)) {
      throw new Error("Invalid compute.free_models: must be an array of non-empty strings");
    }
    freeModels = (c["free_models"] as string[]).map((m) => m.trim());
  }
  if (c["enable_kill_api"] !== undefined && typeof c["enable_kill_api"] !== "boolean") {
    throw new Error("Invalid compute.enable_kill_api: must be a boolean");
  }
  if (c["ledger_path"] !== undefined && (typeof c["ledger_path"] !== "string" || !c["ledger_path"].trim())) {
    throw new Error("Invalid compute.ledger_path: must be a non-empty string");
  }
  return {
    stateDir,
    upstreamBaseUrl: typeof c["upstream_base_url"] === "string" ? c["upstream_base_url"].trim() : undefined,
    apiKeyEnv: typeof c["api_key_env"] === "string" ? c["api_key_env"].trim() : undefined,
    timeoutMs: nonNegNum(c["timeout_ms"], "timeout_ms"),
    freeModels,
    maxTokensPerMinute: nonNegNum(c["max_tokens_per_minute"], "max_tokens_per_minute"),
    maxUsdPerHour: nonNegNum(c["max_usd_per_hour"], "max_usd_per_hour"),
    maxUsdPerDay: nonNegNum(c["max_usd_per_day"], "max_usd_per_day"),
    maxCostPerRequestUsd: nonNegNum(c["max_cost_per_request_usd"], "max_cost_per_request_usd"),
    enableKillApi: typeof c["enable_kill_api"] === "boolean" ? c["enable_kill_api"] : undefined,
    ledgerPath: typeof c["ledger_path"] === "string" ? c["ledger_path"].trim() : undefined,
    port: nonNegNum(c["port"], "port"),
  };
}

/** A non-negative number from the environment variable `name`; unset or empty means `fallback`. */
function num(name: string, fallback: number): number {
  const env = process.env[name];
  if (env === undefined || env === "") return fallback;
  const v = Number(env);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number, got '${env}'`);
  return v;
}

/**
 * The listen port: KILLSWITCH_PORT when it is set, else PORT, else the config
 * file's value (`configKey`), else 4020. An empty variable means unset, as for
 * every other setting. Refuses what `listen` would throw on.
 */
function listenPort(configValue: number | undefined, configKey: string): number {
  const name = process.env.KILLSWITCH_PORT !== undefined ? "KILLSWITCH_PORT" : "PORT";
  const env = process.env[name];
  const [source, value] = env !== undefined && env !== "" ? [name, Number(env)] : [configKey, configValue ?? 4020];
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${source} must be a whole number from 0 to 65535, got '${env !== undefined && env !== "" ? env : String(configValue)}'`);
  }
  return value;
}

function str(env: string | undefined, fallback: string): string {
  return env === undefined || env === "" ? fallback : env;
}

function freeModelList(): string[] {
  return (process.env.KILLSWITCH_FREE_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function configuredRates(base?: ModelRates): ModelRates {
  const env = process.env.KILLSWITCH_MODEL_RATES;
  if (env === undefined) return base ?? parseModelRates({});
  let raw: unknown;
  try { raw = JSON.parse(env); } catch { throw new Error("Invalid KILLSWITCH_MODEL_RATES JSON rates"); }
  return Object.freeze({ ...base, ...parseModelRates(raw) });
}

/** Load YAML config, then apply env overrides. Throws on missing API key unless a free-model allowlist is set. */
export function loadConfig(configPath: string): KillswitchConfig {
  let raw: RawConfig = {};
  if (fs.existsSync(configPath)) {
    let loaded: unknown;
    try {
      loaded = yaml.load(fs.readFileSync(configPath, "utf8")) ?? {};
    } catch (e) {
      // js-yaml appends a multi-line code frame; the first line carries the reason and position.
      throw new Error(`Config file ${configPath} is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
    }
    if (typeof loaded !== "object" || Array.isArray(loaded)) {
      throw new Error(`Config file ${configPath} must be a YAML/JSON object`);
    }
    raw = loaded as RawConfig;
  }

  if (raw.schema !== undefined) {
    if (raw.schema !== BINDING_POLICY_SCHEMA) {
      throw new Error(`Unsupported policy schema '${String(raw.schema)}' (expected '${BINDING_POLICY_SCHEMA}')`);
    }
    const binding = validateBindingComputeSection(raw as unknown as Record<string, unknown>);
    const envFree = freeModelList();
    const freeModels = envFree.length > 0 ? envFree : (binding.freeModels ?? []);
    const apiKeyEnv = str(process.env.KILLSWITCH_API_KEY_ENV, binding.apiKeyEnv ?? "OPENAI_API_KEY");
    const apiKey = freeModels.length > 0 ? "" : (process.env[apiKeyEnv] ?? "");
    if (!apiKey && freeModels.length === 0) {
      throw new Error(
        `Upstream API key missing: set ${apiKeyEnv}, or list free models in KILLSWITCH_FREE_MODELS or compute.free_models`,
      );
    }
    const stateDir = str(process.env.TWZRD_STATE_DIR, binding.stateDir ?? "./data");
    const killFilePath = path.resolve(
      str(process.env.KILLSWITCH_KILL_FILE, path.join(stateDir, ".kill")),
    );
    const pauseFilePath = path.resolve(
      str(process.env.KILLSWITCH_PAUSE_FILE, path.join(stateDir, ".pause")),
    );
    const ledgerPath = path.resolve(
      str(process.env.KILLSWITCH_LEDGER_PATH, binding.ledgerPath ?? path.join(stateDir, "spend-ledger.jsonl")),
    );
    return {
      upstreamBaseUrl: str(
        process.env.KILLSWITCH_UPSTREAM_BASE_URL,
        binding.upstreamBaseUrl ?? "https://api.openai.com/v1",
      ).replace(/\/+$/, ""),
      apiKey,
      freeModels,
      modelRates: configuredRates(),
      upstreamTimeoutMs: Math.floor(
        num("KILLSWITCH_UPSTREAM_TIMEOUT_MS", binding.timeoutMs ?? 60000),
      ),
      maxTokensPerMinute: num(
        "KILLSWITCH_MAX_TOKENS_MINUTE",
        binding.maxTokensPerMinute ?? 100000,
      ),
      maxUsdPerHour: num("KILLSWITCH_MAX_USD_HOUR", binding.maxUsdPerHour ?? 5.0),
      maxUsdPerDay: num("KILLSWITCH_MAX_USD_DAY", binding.maxUsdPerDay ?? 25.0),
      maxCostPerRequestUsd: num(
        "KILLSWITCH_MAX_COST_REQUEST",
        binding.maxCostPerRequestUsd ?? 0.5,
      ),
      killFilePath,
      pauseFilePath,
      enableKillApi:
        process.env.KILLSWITCH_KILL_API !== undefined
          ? process.env.KILLSWITCH_KILL_API === "1" || process.env.KILLSWITCH_KILL_API === "true"
          : (binding.enableKillApi ?? true),
      ledgerPath,
      port: listenPort(binding.port, "compute.port"),
    };
  }

  const freeModels = freeModelList();
  const apiKeyEnv = str(process.env.KILLSWITCH_API_KEY_ENV, raw.upstream?.api_key_env ?? "OPENAI_API_KEY");
  // A free allowlist never copies a key into config, even if one is present in the environment.
  const apiKey = freeModels.length > 0 ? "" : (process.env[apiKeyEnv] ?? "");
  if (!apiKey && freeModels.length === 0) {
    throw new Error(
      `Upstream API key missing: set ${apiKeyEnv}, or list free models in KILLSWITCH_FREE_MODELS`,
    );
  }

  const stateDir = str(process.env.TWZRD_STATE_DIR, "./data");
  const killFilePath = path.resolve(
    str(process.env.KILLSWITCH_KILL_FILE, raw.kill_switch?.file_path ?? path.join(stateDir, ".kill")),
  );
  const pauseFilePath = path.resolve(
    str(
      process.env.KILLSWITCH_PAUSE_FILE,
      raw.kill_switch?.pause_file_path ?? path.join(path.dirname(killFilePath), ".pause"),
    ),
  );

  return {
    upstreamBaseUrl: str(
      process.env.KILLSWITCH_UPSTREAM_BASE_URL,
      raw.upstream?.base_url ?? "https://api.openai.com/v1",
    ).replace(/\/+$/, ""),
    apiKey,
    freeModels,
    modelRates: configuredRates(raw.model_rates === undefined ? undefined : parseModelRates(raw.model_rates)),
    upstreamTimeoutMs: Math.floor(
      num("KILLSWITCH_UPSTREAM_TIMEOUT_MS", raw.upstream?.timeout_ms ?? 60000),
    ),
    maxTokensPerMinute: num(
      "KILLSWITCH_MAX_TOKENS_MINUTE",
      raw.limits?.max_tokens_per_minute ?? 100000,
    ),
    maxUsdPerHour: num("KILLSWITCH_MAX_USD_HOUR", raw.limits?.max_usd_per_hour ?? 5.0),
    maxUsdPerDay: num("KILLSWITCH_MAX_USD_DAY", raw.limits?.max_usd_per_day ?? 25.0),
    maxCostPerRequestUsd: num(
      "KILLSWITCH_MAX_COST_REQUEST",
      raw.limits?.max_cost_per_request_usd ?? 0.5,
    ),
    killFilePath,
    pauseFilePath,
    enableKillApi:
      process.env.KILLSWITCH_KILL_API !== undefined
        ? process.env.KILLSWITCH_KILL_API === "1" || process.env.KILLSWITCH_KILL_API === "true"
        : (raw.kill_switch?.enable_api_endpoint ?? true),
    ledgerPath: path.resolve(str(process.env.KILLSWITCH_LEDGER_PATH, raw.logging?.path ?? path.join(stateDir, "spend-ledger.jsonl"))),
    port: listenPort(raw.server?.port, "server.port"),
  };
}
