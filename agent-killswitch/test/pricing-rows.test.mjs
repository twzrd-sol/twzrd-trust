// Built-in price rows beyond OpenAI. Offline: no network, no key, no spend.
// Every row must be at least the highest price the upstream can bill for that
// exact id, including any premium the request body can select: the agent
// being limited writes the body. Under-pricing is the unsafe direction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { costUsd, parseModelRates, pessimisticRequestCostUsd } from "../dist/pricing.js";

const M = 1_000_000;

function closeTo(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
}

/** Cost of one million input tokens plus one million output tokens. */
function perMillionPair(model, freeModels, rates) {
  return costUsd(model, M, M, freeModels, rates);
}

test("OpenRouter rows use the highest undiscounted price among the endpoints it can route to", () => {
  // Regional Bedrock bills 1.1x, and the >200k prompt tier is $6/$22.50 before that.
  closeTo(perMillionPair("anthropic/claude-sonnet-4.5"), 6.6 + 24.75, "sonnet-4.5");
  closeTo(perMillionPair("anthropic/claude-sonnet-4.6"), 3.3 + 16.5, "sonnet-4.6");
  // The catalog headline is the cheapest endpoint; routing can land on a dearer one,
  // and a listed promotional discount can end.
  closeTo(perMillionPair("deepseek/deepseek-chat"), 0.32 + 1.143, "deepseek-chat");
  closeTo(perMillionPair("deepseek/deepseek-r1-0528"), 0.571 + 2.286, "r1-0528");
  closeTo(perMillionPair("google/gemini-3.7-flash"), 2.7 + 13.5, "gemini-3.7-flash");
  // Google's priority endpoints bill 1.8x, and audio input bills above text.
  closeTo(perMillionPair("google/gemini-2.5-flash"), 1.8 + 4.5, "gemini-2.5-flash");
  closeTo(perMillionPair("anthropic/claude-sonnet-5.5"), 2.2 + 11, "sonnet-5.5");
  closeTo(perMillionPair("deepseek/deepseek-v4-pro"), 1.91 + 3.83, "deepseek-v4-pro");
});

test("a known row priced above the fixed fallback keeps its own price", () => {
  // OpenRouter lists a fast-mode endpoint for Fable 5.2 at $16/$80.
  closeTo(perMillionPair("anthropic/claude-fable-5.2"), 16 + 80, "fable-5.2");
  closeTo(perMillionPair("anthropic/claude-opus-4.1"), 15 + 75, "opus-4.1");
  // A truly unknown id stays on the fixed $15/$60 fallback.
  closeTo(perMillionPair("some-unlisted-model"), 75, "unknown");
});

test("a suffixed or dated id of a row above the fallback keeps the dearer row", () => {
  // OpenRouter's :nitro sorts by throughput, which favours the fast endpoint.
  closeTo(perMillionPair("anthropic/claude-fable-5.2:nitro"), 16 + 80, "fable-5.2:nitro");
  closeTo(perMillionPair("anthropic/claude-opus-4.1:floor"), 15 + 75, "opus-4.1:floor");
  closeTo(perMillionPair("claude-fable-5-2-20261201"), 17.6 + 88, "dated fable-5-2");
  // Below the fallback, a variant still gets the fallback, as before.
  closeTo(perMillionPair("gpt-4o-2024-11-20"), 75, "dated gpt-4o");
  // The same holds for an operator override; an unrelated id is unaffected.
  const rates = parseModelRates({ expensive: { in: 100, out: 200 } });
  closeTo(perMillionPair("expensive:fast", [], rates), 300, "override variant");
  closeTo(perMillionPair("cheap-unrelated", [], rates), 75, "unrelated");
});

test("Gemini API rows price the priority tier and audio input the body can select", () => {
  // The OpenAI compatibility layer honours service_tier="priority" and input_audio.
  closeTo(perMillionPair("gemini-2.5-flash"), 1.8 + 4.5, "gemini-2.5-flash");
  closeTo(perMillionPair("gemini-2.5-flash-lite"), 0.54 + 0.72, "gemini-2.5-flash-lite");
  closeTo(perMillionPair("gemini-2.5-pro"), 4.5 + 27, "gemini-2.5-pro");
  closeTo(perMillionPair("gemini-3.1-pro-preview"), 7.2 + 32.4, "gemini-3.1-pro-preview");
  closeTo(perMillionPair("gemini-3.5-flash-lite"), 0.54 + 4.5, "gemini-3.5-flash-lite");
});

test("Anthropic compatibility rows price fast mode and inference_geo", () => {
  // Fast mode where Anthropic offers it, times the 1.1x US-only multiplier on 4.6 and later.
  closeTo(perMillionPair("claude-fable-5-2"), 17.6 + 88, "claude-fable-5-2");
  closeTo(perMillionPair("claude-mythos-5-2"), 17.6 + 88, "claude-mythos-5-2");
  closeTo(perMillionPair("claude-opus-5-5"), 8.8 + 44, "claude-opus-5-5");
  closeTo(perMillionPair("claude-opus-4-8"), 11 + 55, "claude-opus-4-8");
  closeTo(perMillionPair("claude-sonnet-5-5"), 2.2 + 11, "claude-sonnet-5-5");
  closeTo(perMillionPair("claude-haiku-5-5"), 0.55 + 2.75, "claude-haiku-5-5");
  // Before 4.6: no inference_geo and no fast mode. Sonnet 4.5 keeps its >200k tier.
  closeTo(perMillionPair("claude-sonnet-4-5-20250929"), 6 + 22.5, "claude-sonnet-4-5");
  closeTo(perMillionPair("claude-haiku-4-5-20251001"), 1 + 5, "claude-haiku-4-5");
});

test("DeepSeek API rows use the peak band and cache-miss input", () => {
  closeTo(perMillionPair("deepseek-flash"), 0.3 + 1.2, "deepseek-flash");
  closeTo(perMillionPair("deepseek-v4-flash"), 0.3 + 1.2, "deepseek-v4-flash alias");
  closeTo(perMillionPair("deepseek-v4-pro"), 1.32 + 3.96, "deepseek-v4-pro");
});

test("announced price increases are already in the table", () => {
  // Google doubles Gemini 3.6/3.8 Flash on 2027-01-01 and Gemini 4 on 2026-12-01.
  closeTo(perMillionPair("gemini-3.6-flash"), 2.7 + 13.5, "gemini-3.6-flash");
  closeTo(perMillionPair("gemini-3.8-flash"), 2.7 + 13.5, "gemini-3.8-flash");
  closeTo(perMillionPair("gemini-4-carbon"), 7.2 + 36, "gemini-4-carbon");
  closeTo(perMillionPair("google/gemini-3.8-flash"), 2.7 + 13.5, "or gemini-3.8-flash");
  closeTo(perMillionPair("google/gemini-4-carbon"), 7.2 + 36, "or gemini-4-carbon");
});

test("ids the providers no longer list are not guessed", () => {
  // DeepSeek's pricing page lists deepseek-flash and deepseek-v4-pro only.
  closeTo(perMillionPair("deepseek-reasoner"), 75, "deepseek-reasoner");
  closeTo(perMillionPair("deepseek-chat"), 75, "deepseek-chat");
  closeTo(perMillionPair("claude-3-5-sonnet-20241022"), 75, "claude-3.5-sonnet");
  // Anthropic publishes no price for Mythos Preview.
  closeTo(perMillionPair("claude-mythos-preview"), 75, "claude-mythos-preview");
});

test("the pre-call estimate and the free list use the same rows", () => {
  closeTo(pessimisticRequestCostUsd("claude-sonnet-5-5", 1000), 0.011, "estimate");
  // A priced id stays priced on the free list; a dated variant of it keeps the fallback.
  closeTo(perMillionPair("claude-sonnet-5-5", ["claude-sonnet-5-5"]), 13.2, "free-listed priced id");
  closeTo(perMillionPair("claude-sonnet-5-5-20261101", ["claude-sonnet-5-5-20261101"]), 75, "dated variant");
});
