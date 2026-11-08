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

export function priceFor(model: string): { price: ModelPrice; known: boolean } {
  const price = PRICES[model];
  if (price) return { price, known: true };
  // Fail closed: an unlisted model could be a pricey reasoning model, so we
  // assume the worst instead of silently undercounting spend.
  return { price: mostExpensive(), known: false };
}

export function costUsd(model: string, promptTokens: number, completionTokens: number): number {
  const { price } = priceFor(model);
  return (promptTokens * price.inputPerMTok + completionTokens * price.outputPerMTok) / 1_000_000;
}

/** Pessimistic pre-call estimate: the request's max_tokens all billed at the output rate. */
export function pessimisticRequestCostUsd(model: string, maxTokens: number): number {
  const { price } = priceFor(model);
  return (maxTokens * price.outputPerMTok) / 1_000_000;
}
