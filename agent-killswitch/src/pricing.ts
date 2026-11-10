// Static USD per 1M token estimates. OpenAI rows checked 2026-11-07;
// OpenRouter rows checked 2026-11-10. See README for sources and limitations.
// Unknown ids retain the fixed $15 input / $60 output fallback.

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICES: Record<string, ModelPrice> = {
  // OpenRouter /api/v1/models snapshot 2026-11-10; standard text token estimates.
  "deepseek/deepseek-r1-0528": { inputPerMTok: 0.5, outputPerMTok: 2.15 },
  "deepseek/deepseek-chat": { inputPerMTok: 0.32, outputPerMTok: 0.89 },
  "deepseek/deepseek-chat-v3-0324": { inputPerMTok: 0.29, outputPerMTok: 1.14 },
  "anthropic/claude-sonnet-4.5": { inputPerMTok: 3, outputPerMTok: 15 },
  "anthropic/claude-sonnet-4.6": { inputPerMTok: 3, outputPerMTok: 15 },
  "google/gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  // BlockRun catalog 2026-11-07: billing_mode free, input 0, output 0.
  // The fixed fallback is independent of this free catalog entry.
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

/** Operator configuration only; never accepts request-body pricing. */
export function parseModelRates(raw: unknown): ModelRates {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid model rates: expected an object");
  const rates: Record<string, ModelPrice> = Object.create(null);
  for (const [id, value] of Object.entries(raw)) {
    if (!id.trim() || id !== id.trim() || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model rates entry");
    const v = value as Record<string, unknown>;
    if (Object.keys(v).length !== 2 || !Object.hasOwn(v, "in") || !Object.hasOwn(v, "out") ||
        ![v.in, v.out].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw new Error("Invalid model rates: in/out must be finite nonnegative numbers");
    rates[id] = Object.freeze({inputPerMTok: v.in as number, outputPerMTok: v.out as number});
  }
  return Object.freeze(rates);
}

/** A dated or suffixed id of a priced model (`gpt-4o-2024-11-20`) is not a free model. */
function looksLikePricedModel(model: string, rates?: ModelRates): boolean {
  for (const [id, p] of Object.entries({ ...PRICES, ...rates })) {
    if (p.inputPerMTok === 0 && p.outputPerMTok === 0) continue;
    if (model.startsWith(`${id}-`) || model.startsWith(`${id}:`)) return true;
  }
  return false;
}

const FREE: ModelPrice = { inputPerMTok: 0, outputPerMTok: 0 };

/**
 * `freeModels` is the operator's free allowlist (KILLSWITCH_FREE_MODELS /
 * compute.free_models). A model on it that has no row in the table is the
 * operator's statement that it costs nothing (a local Ollama model, a free
 * catalog entry), so it is priced at $0 and not at the o1 fallback. A model
 * that does have a row keeps that row, and a dated or suffixed id of a priced
 * model (`gpt-4o-2024-11-20`) keeps the o1 fallback: listing `gpt-4o` as free
 * does not zero a priced model. The caller passes no list for a call that
 * carries a payment credential. Token limits apply either way.
 */
export function priceFor(model: string, freeModels?: readonly string[] | null, rates?: ModelRates): { price: ModelPrice; known: boolean } {
  const price = rates && Object.hasOwn(rates, model) ? rates[model] : Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (price) return { price, known: true };
  if (freeModels && freeModels.includes(model) && !looksLikePricedModel(model, rates)) return { price: FREE, known: false };
  // Fail closed: an unlisted model could be a pricey reasoning model, so we
  // assume the worst instead of silently undercounting spend.
  return { price: FALLBACK, known: false };
}

export function costUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  freeModels?: readonly string[] | null,
  rates?: ModelRates,
): number {
  const { price } = priceFor(model, freeModels, rates);
  return (promptTokens * price.inputPerMTok + completionTokens * price.outputPerMTok) / 1_000_000;
}

/** Pessimistic pre-call estimate: the request's max_tokens all billed at the output rate. */
export function pessimisticRequestCostUsd(model: string, maxTokens: number, freeModels?: readonly string[] | null, rates?: ModelRates): number {
  const { price } = priceFor(model, freeModels, rates);
  return (maxTokens * price.outputPerMTok) / 1_000_000;
}
