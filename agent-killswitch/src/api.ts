import {
  evaluateGate,
  requestEstimate,
  vetoBody,
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

function finiteNonNegative(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
}

function modelId(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
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
  return Object.freeze(value.map((id, index) => modelId(`${name}[${index}]`, id)));
}

function snapshotRates(value: ModelRates | undefined): ModelRates | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("modelRates must be an object");
  }
  const snapshot: Record<string, ModelPrice> = Object.create(null);
  for (const [id, price] of Object.entries(value)) {
    modelId("modelRates id", id);
    if (!price || typeof price !== "object" || Array.isArray(price)) {
      throw new TypeError(`modelRates.${id} must be a model price`);
    }
    finiteNonNegative(`modelRates.${id}.inputPerMTok`, price.inputPerMTok);
    finiteNonNegative(`modelRates.${id}.outputPerMTok`, price.outputPerMTok);
    snapshot[id] = Object.freeze({
      inputPerMTok: price.inputPerMTok,
      outputPerMTok: price.outputPerMTok,
    });
  }
  return Object.freeze(snapshot);
}

/**
 * Bind fixed limits to the same pure admission math used by the HTTP proxy.
 *
 * This helper performs no I/O and keeps no spend state. The caller supplies a
 * live spend window (including in-flight holds) and records actual usage after
 * an allowed operation completes. Use the CLI proxy when you want the package
 * to own the JSONL ledger and upstream request lifecycle.
 */
export function createBudgetGate(options: BudgetGateOptions): BudgetGate {
  finiteNonNegative("maxTokensPerMinute", options.maxTokensPerMinute);
  finiteNonNegative("maxUsdPerHour", options.maxUsdPerHour);
  finiteNonNegative("maxUsdPerDay", options.maxUsdPerDay);
  finiteNonNegative("maxCostPerRequestUsd", options.maxCostPerRequestUsd);

  // Snapshot policy once. A caller mutating the object it passed after this
  // point must never loosen a live gate.
  const maxTokensPerMinute = options.maxTokensPerMinute;
  const maxUsdPerHour = options.maxUsdPerHour;
  const maxUsdPerDay = options.maxUsdPerDay;
  const maxCostPerRequestUsd = options.maxCostPerRequestUsd;
  const allowedModels = snapshotList("allowedModels", options.allowedModels);
  const defaultZeroPriceModels = snapshotList("zeroPriceModels", options.zeroPriceModels);
  const modelRates = snapshotRates(options.modelRates);

  function zeroPriceModelsFor(request: BudgetGateEstimateInput): readonly string[] | null {
    return request.zeroPriceModels === undefined
      ? defaultZeroPriceModels
      : snapshotList("zeroPriceModels", request.zeroPriceModels);
  }

  return Object.freeze({
    evaluate(request: BudgetGateRequest): GateDecision {
      const model = modelId("model", request.model);
      finiteNonNegative("window.minuteTokens", request.window?.minuteTokens);
      finiteNonNegative("window.hourUsd", request.window?.hourUsd);
      finiteNonNegative("window.dayUsd", request.window?.dayUsd);
      return evaluateGate({
        killed: request.killed ?? false,
        paused: request.paused ?? false,
        pauseReason: request.pauseReason ?? null,
        pauseDecisionId: request.pauseDecisionId ?? null,
        window: {
          minuteTokens: request.window.minuteTokens,
          hourUsd: request.window.hourUsd,
          dayUsd: request.window.dayUsd,
        },
        model,
        maxTokens: maxTokens(request.maxTokens),
        maxTokensPerMinute,
        maxUsdPerHour,
        maxUsdPerDay,
        maxCostPerRequestUsd,
        allowedModels,
        zeroPriceModels: zeroPriceModelsFor(request),
        modelRates,
      });
    },
    estimate(request: BudgetGateEstimateInput): RequestEstimate {
      return requestEstimate(
        modelId("model", request.model),
        maxTokens(request.maxTokens),
        maxCostPerRequestUsd,
        zeroPriceModelsFor(request),
        modelRates,
      );
    },
  });
}
