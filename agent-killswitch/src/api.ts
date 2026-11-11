import {
  evaluateGate,
  requestEstimate,
  type GateDecision,
  type RequestEstimate,
  type SpendWindow,
} from "./gate.js";
import type { ModelPrice, ModelRates } from "./pricing.js";

export type {
  GateDecision,
  RequestEstimate,
  SpendWindow,
  VetoCode,
} from "./gate.js";
export type { ModelPrice, ModelRates } from "./pricing.js";

export interface BudgetGateOptions {
  maxTokensPerMinute: number;
  maxUsdPerHour: number;
  maxUsdPerDay: number;
  maxCostPerRequestUsd: number;
  modelRates?: ModelRates;
  allowedModels?: readonly string[] | null;
  zeroPriceModels?: readonly string[] | null;
}

export interface BudgetGateEstimateInput {
  model: string;
  maxTokens?: number | null;
  /** Override the gate-wide zero-price list for this request. */
  zeroPriceModels?: readonly string[] | null;
}

export interface BudgetGateRequest extends BudgetGateEstimateInput {
  /** Current recorded spend plus any in-flight holds maintained by the caller. */
  window: SpendWindow;
  killed?: boolean;
  paused?: boolean;
  pauseReason?: string | null;
  pauseDecisionId?: string | null;
}

export interface BudgetGate {
  evaluate(request: BudgetGateRequest): GateDecision;
  estimate(request: BudgetGateEstimateInput): RequestEstimate;
}

// Every checked value is read exactly once, into a local, and only the local
// is used afterwards. Reading twice — even for an accessor that lies — cannot
// pass validation on the first read and fail open on the second.
function finiteNonNegative(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function modelId(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string or null`);
  }
  return value;
}

function optionalBoolean(name: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

function maxTokens(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new TypeError("maxTokens must be null or a finite non-negative integer");
  }
  return value;
}

function snapshotList(
  name: string,
  value: readonly string[] | null | undefined,
): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of model ids`);
  const ids: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    ids.push(modelId(`${name}[${index}]`, value[index]));
  }
  return Object.freeze(ids);
}

function snapshotRates(value: ModelRates | undefined): ModelRates | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("modelRates must be an object");
  }
  const snapshot: Record<string, ModelPrice> = Object.create(null);
  for (const [rawId, price] of Object.entries(value)) {
    const id = modelId("modelRates id", rawId);
    if (!price || typeof price !== "object" || Array.isArray(price)) {
      throw new TypeError(`modelRates.${id} must be a model price`);
    }
    const entries = price as unknown as Record<string, unknown>;
    const inputPerMTok = finiteNonNegative(`modelRates.${id}.inputPerMTok`, entries["inputPerMTok"]);
    const outputPerMTok = finiteNonNegative(`modelRates.${id}.outputPerMTok`, entries["outputPerMTok"]);
    snapshot[id] = Object.freeze({ inputPerMTok, outputPerMTok });
  }
  return Object.freeze(snapshot);
}

/**
 * Bind fixed limits to the same pure admission math used by the HTTP proxy.
 *
 * This helper performs no I/O and keeps no spend state. The caller supplies a
 * live spend window (including in-flight holds) and records actual usage after
 * an allowed operation completes. Add the `estimate()` hold to the window
 * synchronously, before the first await; Mastra runs tool calls in parallel,
 * and two calls that read the same unheld window both pass. Use the CLI proxy
 * when you want the package to own the JSONL ledger and upstream lifecycle.
 */
export function createBudgetGate(options: BudgetGateOptions): BudgetGate {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }

  // Snapshot policy once. A caller mutating the object it passed after this
  // point must never loosen a live gate.
  const maxTokensPerMinute = finiteNonNegative("maxTokensPerMinute", options.maxTokensPerMinute);
  const maxUsdPerHour = finiteNonNegative("maxUsdPerHour", options.maxUsdPerHour);
  const maxUsdPerDay = finiteNonNegative("maxUsdPerDay", options.maxUsdPerDay);
  const maxCostPerRequestUsd = finiteNonNegative("maxCostPerRequestUsd", options.maxCostPerRequestUsd);
  const allowedModels = snapshotList("allowedModels", options.allowedModels);
  if (allowedModels !== null && allowedModels.length === 0) {
    // An empty list cannot mean "no allowlist" here — the gate math reads []
    // as exactly that. Reading it as "allow none" would be the only useful
    // interpretation; make the caller say which they mean.
    throw new TypeError("allowedModels must not be empty; pass null (or omit it) for no allowlist");
  }
  const defaultZeroPriceModels = snapshotList("zeroPriceModels", options.zeroPriceModels);
  const modelRates = snapshotRates(options.modelRates);

  function zeroPriceModelsFor(request: BudgetGateEstimateInput): readonly string[] | null {
    const value = request.zeroPriceModels;
    return value === undefined ? defaultZeroPriceModels : snapshotList("zeroPriceModels", value);
  }

  return Object.freeze({
    evaluate(request: BudgetGateRequest): GateDecision {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw new TypeError("request must be an object");
      }
      const model = modelId("model", request.model);
      const rawWindow = request.window;
      if (!rawWindow || typeof rawWindow !== "object" || Array.isArray(rawWindow)) {
        throw new TypeError("window must be an object with minuteTokens, hourUsd and dayUsd");
      }
      const minuteTokens = finiteNonNegative("window.minuteTokens", rawWindow.minuteTokens);
      const hourUsd = finiteNonNegative("window.hourUsd", rawWindow.hourUsd);
      const dayUsd = finiteNonNegative("window.dayUsd", rawWindow.dayUsd);
      const tokens = maxTokens(request.maxTokens);
      const killed = optionalBoolean("killed", request.killed);
      const paused = optionalBoolean("paused", request.paused);
      const pauseReason = optionalString("pauseReason", request.pauseReason);
      const pauseDecisionId = optionalString("pauseDecisionId", request.pauseDecisionId);
      const zeroPriceModels = zeroPriceModelsFor(request);
      return evaluateGate({
        killed,
        paused,
        pauseReason,
        pauseDecisionId,
        window: { minuteTokens, hourUsd, dayUsd },
        model,
        maxTokens: tokens,
        maxTokensPerMinute,
        maxUsdPerHour,
        maxUsdPerDay,
        maxCostPerRequestUsd,
        allowedModels,
        zeroPriceModels,
        modelRates,
      });
    },
    estimate(request: BudgetGateEstimateInput): RequestEstimate {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw new TypeError("request must be an object");
      }
      const model = modelId("model", request.model);
      const tokens = maxTokens(request.maxTokens);
      return requestEstimate(
        model,
        tokens,
        maxCostPerRequestUsd,
        zeroPriceModelsFor(request),
        modelRates,
      );
    },
  });
}
