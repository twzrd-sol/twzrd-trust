// Static USD per 1M token budget estimates, not the price a given call pays.
// OpenAI rows checked 2026-11-07; every other row checked 2026-11-10 against
// the sources named above its group.
// Each row is the highest price the upstream can bill for that exact id,
// including any premium the request body can select (the agent being limited
// writes the body), the top prompt-length tier and announced increases:
// under-pricing is the unsafe direction. Unknown ids keep the fixed $15 input / $60 output
// fallback; a known row may sit above it. See README "Pricing notes".

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * Flat USD charged per request on top of the token rates (operator rows
   * only; no built-in row sets it). A seller that bills one fixed amount per
   * request (an MPP session voucher of 750 base units, for example) is a row
   * with `inputPerMTok: 0, outputPerMTok: 0, perRequestUsd: 0.00075`: the
   * hold before the call and the ledger cost after it are both that amount.
   * Absent means 0.
   */
  perRequestUsd?: number;
}

const PRICES: Record<string, ModelPrice> = {
  // OpenRouter ids. Each row is the highest price among the endpoints
  // /api/v1/models/<id>/endpoints listed on 2026-11-10: prompt-length tiers,
  // regional, fast and priority endpoints, audio input where it bills above
  // text, and the undiscounted price where an endpoint lists a discount.
  // OpenRouter picks the provider per request, so any of them can bill the call.
  "anthropic/claude-fable-5": { inputPerMTok: 11, outputPerMTok: 55 },
  "anthropic/claude-fable-5.1": { inputPerMTok: 10, outputPerMTok: 50 },
  "anthropic/claude-fable-5.2": { inputPerMTok: 16, outputPerMTok: 80 },
  "anthropic/claude-haiku-4.5": { inputPerMTok: 1.1, outputPerMTok: 5.5 },
  "anthropic/claude-haiku-5.5": { inputPerMTok: 0.55, outputPerMTok: 2.75 },
  "anthropic/claude-opus-4.1": { inputPerMTok: 15, outputPerMTok: 75 },
  "anthropic/claude-opus-4.5": { inputPerMTok: 5.5, outputPerMTok: 27.5 },
  "anthropic/claude-opus-4.6": { inputPerMTok: 5.5, outputPerMTok: 27.5 },
  "anthropic/claude-opus-4.7": { inputPerMTok: 5.5, outputPerMTok: 27.5 },
  "anthropic/claude-opus-4.8": { inputPerMTok: 10, outputPerMTok: 50 },
  "anthropic/claude-opus-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "anthropic/claude-opus-5.5": { inputPerMTok: 8, outputPerMTok: 40 },
  "anthropic/claude-sonnet-4.5": { inputPerMTok: 6.6, outputPerMTok: 24.75 },
  "anthropic/claude-sonnet-4.6": { inputPerMTok: 3.3, outputPerMTok: 16.5 },
  "anthropic/claude-sonnet-5": { inputPerMTok: 2.2, outputPerMTok: 11 },
  "anthropic/claude-sonnet-5.5": { inputPerMTok: 2.2, outputPerMTok: 11 },
  "deepseek/deepseek-chat": { inputPerMTok: 0.32, outputPerMTok: 1.143 },
  "deepseek/deepseek-chat-v3-0324": { inputPerMTok: 0.29, outputPerMTok: 1.14 },
  "deepseek/deepseek-chat-v3.1": { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  "deepseek/deepseek-r1-0528": { inputPerMTok: 0.571, outputPerMTok: 2.286 },
  "deepseek/deepseek-v3.2": { inputPerMTok: 0.3, outputPerMTok: 0.96 },
  "deepseek/deepseek-v4-flash": { inputPerMTok: 0.21, outputPerMTok: 0.56 },
  "deepseek/deepseek-v4-pro": { inputPerMTok: 1.91, outputPerMTok: 3.83 },
  "deepseek/deepseek-v4.1-flash": { inputPerMTok: 0.45, outputPerMTok: 1.8 },
  "google/gemini-2.5-flash": { inputPerMTok: 1.8, outputPerMTok: 4.5 },
  "google/gemini-2.5-flash-lite": { inputPerMTok: 0.54, outputPerMTok: 0.72 },
  "google/gemini-2.5-pro": { inputPerMTok: 4.5, outputPerMTok: 27 },
  "google/gemini-3-flash-preview": { inputPerMTok: 1.8, outputPerMTok: 5.4 },
  "google/gemini-3.1-flash-lite": { inputPerMTok: 0.9, outputPerMTok: 2.7 },
  "google/gemini-3.1-pro-preview": { inputPerMTok: 7.2, outputPerMTok: 32.4 },
  "google/gemini-3.5-flash": { inputPerMTok: 5.4, outputPerMTok: 16.2 },
  "google/gemini-3.5-flash-lite": { inputPerMTok: 0.54, outputPerMTok: 4.5 },
  "google/gemini-3.6-flash": { inputPerMTok: 2.7, outputPerMTok: 13.5 },  // x2 from 2027-01-01 applied
  "google/gemini-3.7-flash": { inputPerMTok: 2.7, outputPerMTok: 13.5 },
  "google/gemini-3.8-flash": { inputPerMTok: 2.7, outputPerMTok: 13.5 },  // x2 from 2027-01-01 applied
  "google/gemini-4-argon": { inputPerMTok: 7.2, outputPerMTok: 36 },  // x2 from 2026-12-01 applied
  "google/gemini-4-carbon": { inputPerMTok: 7.2, outputPerMTok: 36 },  // x2 from 2026-12-01 applied
  // Anthropic OpenAI SDK compatibility layer (base URL https://api.anthropic.com/v1/),
  // ids from its supported-model list, prices from platform.claude.com pricing.
  // The layer documents neither fast mode nor inference_geo, and it forwards some
  // extra body fields (thinking), so both are priced in: fast mode where Anthropic
  // offers it, times 1.1x US-only inference on Claude 4.6 and later. Haiku 5.5
  // uses its over-100k-prompt tier. Sonnet 4.5 uses the over-200k tier ($6/$22.50)
  // that OpenRouter lists for Anthropic's own AWS endpoint; Anthropic's page lists
  // $3/$15. claude-mythos-preview has no published price and stays on the fallback.
  "claude-fable-5-2": { inputPerMTok: 17.6, outputPerMTok: 88 },
  "claude-mythos-5-2": { inputPerMTok: 17.6, outputPerMTok: 88 },
  "claude-fable-5-1": { inputPerMTok: 11, outputPerMTok: 55 },
  "claude-mythos-5-1": { inputPerMTok: 11, outputPerMTok: 55 },
  "claude-fable-5": { inputPerMTok: 11, outputPerMTok: 55 },
  "claude-mythos-5": { inputPerMTok: 11, outputPerMTok: 55 },
  "claude-opus-5-5": { inputPerMTok: 8.8, outputPerMTok: 44 },
  "claude-opus-5": { inputPerMTok: 11, outputPerMTok: 55 },
  "claude-opus-4-8": { inputPerMTok: 11, outputPerMTok: 55 },
  "claude-opus-4-7": { inputPerMTok: 5.5, outputPerMTok: 27.5 },
  "claude-opus-4-6": { inputPerMTok: 5.5, outputPerMTok: 27.5 },
  "claude-opus-4-5-20251101": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5-5": { inputPerMTok: 2.2, outputPerMTok: 11 },
  "claude-sonnet-5": { inputPerMTok: 2.2, outputPerMTok: 11 },
  "claude-sonnet-4-6": { inputPerMTok: 3.3, outputPerMTok: 16.5 },
  "claude-sonnet-4-5-20250929": { inputPerMTok: 6, outputPerMTok: 22.5 },
  "claude-haiku-5-5": { inputPerMTok: 0.55, outputPerMTok: 2.75 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
  // DeepSeek API (https://api.deepseek.com), api-docs.deepseek.com pricing: peak
  // band, cache-miss input. deepseek-v4-flash and deepseek-v4-flash-vision-exp
  // are legacy names DeepSeek still accepts and bills at the Flash price.
  "deepseek-flash": { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  "deepseek-v4-flash": { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  "deepseek-v4-flash-vision-exp": { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  "deepseek-v4-pro": { inputPerMTok: 1.32, outputPerMTok: 3.96 },
  // Gemini API OpenAI compatibility, aistudio.google.com/docs/pricing. The layer
  // honours service_tier="priority" and input_audio from the request body, so rows
  // use the Priority tier (1.8x), audio input where it bills above text, and the
  // top prompt-length tier.
  "gemini-2.5-flash": { inputPerMTok: 1.8, outputPerMTok: 4.5 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.54, outputPerMTok: 0.72 },
  "gemini-2.5-pro": { inputPerMTok: 4.5, outputPerMTok: 27 },
  "gemini-3-flash-preview": { inputPerMTok: 1.8, outputPerMTok: 5.4 },
  "gemini-3.1-flash-lite": { inputPerMTok: 0.9, outputPerMTok: 2.7 },
  "gemini-3.1-pro-preview": { inputPerMTok: 7.2, outputPerMTok: 32.4 },
  "gemini-3.5-flash-lite": { inputPerMTok: 0.54, outputPerMTok: 4.5 },
  "gemini-3.6-flash": { inputPerMTok: 2.7, outputPerMTok: 13.5 },  // Priority price from 2027-01-01
  "gemini-3.8-flash": { inputPerMTok: 2.7, outputPerMTok: 13.5 },  // Priority price from 2027-01-01
  "gemini-4-carbon": { inputPerMTok: 7.2, outputPerMTok: 36 },  // Priority price from 2026-12-01
  "gemini-4-argon": { inputPerMTok: 7.2, outputPerMTok: 36 },  // Priority price from 2026-12-01
  // BlockRun catalog 2026-11-07: billing_mode free, input 0, output 0.
  // A $0 row is a free-catalog entry, not a price: priceFor drops it for a
  // call whose zero-price list does not name the model (a paid call).
  "nvidia/nemotron-3.5-bolt": { inputPerMTok: 0, outputPerMTok: 0 },
  "o1": { inputPerMTok: 15.0, outputPerMTok: 60.0 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10.0 },
  "gpt-4.1": { inputPerMTok: 2.0, outputPerMTok: 8.0 },
  "o3-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
};

export type ModelRates = Readonly<Record<string, ModelPrice>>;
const FALLBACK: ModelPrice = { inputPerMTok: 15, outputPerMTok: 60 };

/** The flat per-request part of a price (0 when the row has none). */
export function flatUsd(price: ModelPrice): number {
  return price.perRequestUsd ?? 0;
}

/** A row that charges nothing at all: no token rate and no flat per-request amount. */
export function isZeroPrice(price: ModelPrice): boolean {
  return price.inputPerMTok === 0 && price.outputPerMTok === 0 && flatUsd(price) === 0;
}

const isRate = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * Operator configuration only; never accepts request-body pricing.
 * Each entry is `{in, out}` (USD per 1M tokens) or `{in, out, per_request}`
 * (plus a flat USD amount per request). Any other key fails.
 */
export function parseModelRates(raw: unknown): ModelRates {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid model rates: expected an object");
  const rates: Record<string, ModelPrice> = Object.create(null);
  for (const [id, value] of Object.entries(raw)) {
    if (!id.trim() || id !== id.trim() || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model rates entry");
    const v = value as Record<string, unknown>;
    const keys = Object.keys(v);
    const flat = Object.hasOwn(v, "per_request");
    if (keys.length !== (flat ? 3 : 2) || !Object.hasOwn(v, "in") || !Object.hasOwn(v, "out") ||
        ![v.in, v.out].every(isRate)) throw new Error("Invalid model rates: in/out must be finite nonnegative numbers");
    if (flat && !isRate(v.per_request)) throw new Error("Invalid model rates: per_request must be a finite nonnegative number");
    rates[id] = Object.freeze(
      flat
        ? { inputPerMTok: v.in as number, outputPerMTok: v.out as number, perRequestUsd: v.per_request as number }
        : { inputPerMTok: v.in as number, outputPerMTok: v.out as number },
    );
  }
  return Object.freeze(rates);
}

/** A dated or suffixed id of a priced model (`gpt-4o-2024-11-20`) is not a free model. */
function looksLikePricedModel(model: string, rates?: ModelRates): boolean {
  for (const [id, p] of Object.entries({ ...PRICES, ...rates })) {
    if (isZeroPrice(p)) continue;
    if (model.startsWith(`${id}-`) || model.startsWith(`${id}:`)) return true;
  }
  return false;
}

const FREE: ModelPrice = { inputPerMTok: 0, outputPerMTok: 0 };

/**
 * Price for an id with no row: the fixed fallback, raised per component to any
 * priced id it extends (`<id>:nitro`, `<id>-20261201`). A variant of a row above
 * the fallback (an OpenRouter fast endpoint, an expensive override) keeps the
 * dearer row; an unrelated id gets the fallback unchanged.
 */
function fallbackFor(model: string, rates?: ModelRates): ModelPrice {
  let inputPerMTok = FALLBACK.inputPerMTok;
  let outputPerMTok = FALLBACK.outputPerMTok;
  let perRequestUsd = 0;
  for (const [id, p] of Object.entries({ ...PRICES, ...rates })) {
    if (model.startsWith(`${id}-`) || model.startsWith(`${id}:`)) {
      inputPerMTok = Math.max(inputPerMTok, p.inputPerMTok);
      outputPerMTok = Math.max(outputPerMTok, p.outputPerMTok);
      perRequestUsd = Math.max(perRequestUsd, flatUsd(p));
    }
  }
  return perRequestUsd > 0 ? { inputPerMTok, outputPerMTok, perRequestUsd } : { inputPerMTok, outputPerMTok };
}

/**
 * `freeModels` is the zero-price list for this call: the operator's free
 * allowlist (KILLSWITCH_FREE_MODELS / compute.free_models) for an unpaid
 * call, and an empty list for a call that carries a payment credential.
 * Absent (null or undefined) means the caller made no statement.
 *
 * - An operator rate (`rates`) is used as given, at $0 or not.
 * - A built-in row above $0 is used as given: listing `gpt-4o` as free does
 *   not zero a priced model.
 * - A built-in $0 row is a catalog saying the model is free. It is used when
 *   the list is absent or names the model. An explicit list that does not
 *   name it (the empty list of a paid call) leaves the model at the
 *   fallback: a call that pays for a model is not a free call.
 * - A model with no row is $0 when the list names it (a local Ollama model,
 *   a free catalog entry), unless it is a dated or suffixed id of a priced
 *   model (`gpt-4o-2024-11-20`).
 * - Everything else is the fallback. Token limits apply either way.
 */
export function priceFor(model: string, freeModels?: readonly string[] | null, rates?: ModelRates): { price: ModelPrice; known: boolean } {
  if (rates && Object.hasOwn(rates, model)) return { price: rates[model], known: true };
  const listed = Array.isArray(freeModels) && freeModels.includes(model);
  const row = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (row) {
    const zeroRow = isZeroPrice(row);
    if (!zeroRow || listed || !Array.isArray(freeModels)) return { price: row, known: true };
  } else if (listed && !looksLikePricedModel(model, rates)) {
    return { price: FREE, known: false };
  }
  // Fail closed: an unlisted model could be a pricey reasoning model, so we
  // assume the worst instead of silently undercounting spend.
  return { price: fallbackFor(model, rates), known: false };
}

export function costUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  freeModels?: readonly string[] | null,
  rates?: ModelRates,
): number {
  const { price } = priceFor(model, freeModels, rates);
  return (promptTokens * price.inputPerMTok + completionTokens * price.outputPerMTok) / 1_000_000 + flatUsd(price);
}

/** Pessimistic pre-call estimate: the request's max_tokens all billed at the output rate, plus any flat per-request amount. */
export function pessimisticRequestCostUsd(model: string, maxTokens: number, freeModels?: readonly string[] | null, rates?: ModelRates): number {
  const { price } = priceFor(model, freeModels, rates);
  return (maxTokens * price.outputPerMTok) / 1_000_000 + flatUsd(price);
}
