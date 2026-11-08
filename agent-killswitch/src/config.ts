import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";

export interface KillswitchConfig {
  upstreamBaseUrl: string;
  apiKey: string;
  /**
   * Exact upstream model ids that may be forwarded. Non-empty means this
   * process does not read or send an upstream API key: a model outside the
   * list is vetoed before the request leaves the machine.
   */
  freeModels: string[];
  /** Milliseconds to wait for upstream response headers (and the whole body when not streaming). 0 disables. */
  upstreamTimeoutMs: number;
  maxTokensPerMinute: number;
  maxUsdPerHour: number;
  maxUsdPerDay: number;
  maxCostPerRequestUsd: number;
  killFilePath: string;
  enableKillApi: boolean;
  ledgerPath: string;
  port: number;
}

interface RawConfig {
  upstream?: { base_url?: string; api_key_env?: string; timeout_ms?: number };
  limits?: {
    max_tokens_per_minute?: number;
    max_usd_per_hour?: number;
    max_usd_per_day?: number;
    max_cost_per_request_usd?: number;
  };
  kill_switch?: { file_path?: string; enable_api_endpoint?: boolean };
  logging?: { path?: string };
  server?: { port?: number };
}

function num(env: string | undefined, fallback: number): number {
  if (env === undefined || env === "") return fallback;
  const v = Number(env);
  if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid numeric env value: ${env}`);
  return v;
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

/** Load YAML config, then apply env overrides. Throws on missing API key unless a free-model allowlist is set. */
export function loadConfig(configPath: string): KillswitchConfig {
  let raw: RawConfig = {};
  if (fs.existsSync(configPath)) {
    raw = (yaml.load(fs.readFileSync(configPath, "utf8")) ?? {}) as RawConfig;
  }

  const freeModels = freeModelList();
  const apiKeyEnv = str(process.env.KILLSWITCH_API_KEY_ENV, raw.upstream?.api_key_env ?? "OPENAI_API_KEY");
  // A free allowlist never copies a key into config, even if one is present in the environment.
  const apiKey = freeModels.length > 0 ? "" : (process.env[apiKeyEnv] ?? "");
  if (!apiKey && freeModels.length === 0) {
    throw new Error(`Upstream API key missing: set ${apiKeyEnv}`);
  }

  return {
    upstreamBaseUrl: str(
      process.env.KILLSWITCH_UPSTREAM_BASE_URL,
      raw.upstream?.base_url ?? "https://api.openai.com/v1",
    ).replace(/\/+$/, ""),
    apiKey,
    freeModels,
    upstreamTimeoutMs: Math.floor(
      num(process.env.KILLSWITCH_UPSTREAM_TIMEOUT_MS, raw.upstream?.timeout_ms ?? 60000),
    ),
    maxTokensPerMinute: num(
      process.env.KILLSWITCH_MAX_TOKENS_MINUTE,
      raw.limits?.max_tokens_per_minute ?? 100000,
    ),
    maxUsdPerHour: num(process.env.KILLSWITCH_MAX_USD_HOUR, raw.limits?.max_usd_per_hour ?? 5.0),
    maxUsdPerDay: num(process.env.KILLSWITCH_MAX_USD_DAY, raw.limits?.max_usd_per_day ?? 25.0),
    maxCostPerRequestUsd: num(
      process.env.KILLSWITCH_MAX_COST_REQUEST,
      raw.limits?.max_cost_per_request_usd ?? 0.5,
    ),
    killFilePath: path.resolve(
      str(process.env.KILLSWITCH_KILL_FILE, raw.kill_switch?.file_path ?? "./data/.kill"),
    ),
    enableKillApi:
      process.env.KILLSWITCH_KILL_API !== undefined
        ? process.env.KILLSWITCH_KILL_API === "1" || process.env.KILLSWITCH_KILL_API === "true"
        : (raw.kill_switch?.enable_api_endpoint ?? true),
    ledgerPath: path.resolve(str(process.env.KILLSWITCH_LEDGER_PATH, raw.logging?.path ?? "./data/spend-ledger.jsonl")),
    port: Math.floor(num(process.env.KILLSWITCH_PORT ?? process.env.PORT, raw.server?.port ?? 4020)),
  };
}
