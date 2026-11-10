// Static per-model prices in USD per 1M tokens. Checked against OpenAI's
// published pricing 2026-11-07; update this table when OpenAI changes prices.
// Unknown models are priced as the most expensive known model (fail closed),
// never as the cheapest. See README for the rationale.

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICES: Record<string, ModelPrice> = {
  // BlockRun catalog 2026-11-07: billing_mode free, input 0, output 0.
  // mostExpensive() uses a strict greater-than, so this row cannot become the
  // fallback price for an unknown model. A keyed call is a separate process.
  "nvidia/nemotron-3.5-bolt": { inputPerMTok: 0, outputPerMTok: 0 },
  "o1": { inputPerMTok: 15.0, outputPerMTok: 60.0 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10.0 },
  "gpt-4.1": { inputPerMTok: 2.0, outputPerMTok: 8.0 },
  "o3-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
};

function mostExpensive(): ModelPrice {
  let top: ModelPrice = { inputPerMTok: 0, outputPerMTok: 0 };
  for (const p of Object.values(PRICES)) {
    if (p.outputPerMTok > top.outputPerMTok) top = p;
  }
  return top;
}

/** A dated or suffixed id of a priced model (`gpt-4o-2024-11-20`) is not a free model. */
function looksLikePricedModel(model: string): boolean {
  for (const [id, p] of Object.entries(PRICES)) {
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
export function priceFor(model: string, freeModels?: readonly string[] | null): { price: ModelPrice; known: boolean } {
  const price = PRICES[model];
  if (price) return { price, known: true };
  if (freeModels && freeModels.includes(model) && !looksLikePricedModel(model)) return { price: FREE, known: false };
  // Fail closed: an unlisted model could be a pricey reasoning model, so we
  // assume the worst instead of silently undercounting spend.
  return { price: mostExpensive(), known: false };
}

export function costUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  freeModels?: readonly string[] | null,
): number {
  const { price } = priceFor(model, freeModels);
  return (promptTokens * price.inputPerMTok + completionTokens * price.outputPerMTok) / 1_000_000;
}

/** Pessimistic pre-call estimate: the request's max_tokens all billed at the output rate. */
export function pessimisticRequestCostUsd(model: string, maxTokens: number, freeModels?: readonly string[] | null): number {
  const { price } = priceFor(model, freeModels);
  return (maxTokens * price.outputPerMTok) / 1_000_000;
}
