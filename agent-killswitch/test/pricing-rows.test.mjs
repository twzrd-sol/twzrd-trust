// Built-in price rows beyond OpenAI. Offline: no network, no key, no spend.
// Every row must be at least the highest price the upstream can bill for that
// exact id; under-pricing is the unsafe direction (see README "Pricing notes").
import { test } from "node:test";
import assert from "node:assert/strict";
import { costUsd, pessimisticRequestCostUsd } from "../dist/pricing.js";

const M = 1_000_000;

function closeTo(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
}

/** Cost of one million input tokens plus one million output tokens. */
function perMillionPair(model, freeModels) {
  return costUsd(model, M, M, freeModels);
}

test("OpenRouter rows use the highest price among the endpoints it can route to", () => {
  // Regional Bedrock bills 1.1x, and the >200k prompt tier is $6/$22.50 before that.
  closeTo(perMillionPair("anthropic/claude-sonnet-4.5"), 6.6 + 24.75, "sonnet-4.5");
  closeTo(perMillionPair("anthropic/claude-sonnet-4.6"), 3.3 + 16.5, "sonnet-4.6");
  // The catalog headline is the cheapest endpoint; routing can land on a dearer one.
  closeTo(perMillionPair("deepseek/deepseek-chat"), 0.32 + 1.0287, "deepseek-chat");
  closeTo(perMillionPair("deepseek/deepseek-r1-0528"), 0.571 + 2.286, "r1-0528");
  // Google's priority endpoints bill 1.8x standard.
  closeTo(perMillionPair("google/gemini-2.5-flash"), 0.54 + 4.5, "gemini-2.5-flash");
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

test("direct OpenAI-compatible provider ids are priced instead of falling back", () => {
  // Anthropic compatibility layer (api.anthropic.com/v1/), standard pricing.
  closeTo(perMillionPair("claude-fable-5-2"), 8 + 40, "claude-fable-5-2");
  closeTo(perMillionPair("claude-opus-5-5"), 4 + 20, "claude-opus-5-5");
  closeTo(perMillionPair("claude-sonnet-5-5"), 2 + 10, "claude-sonnet-5-5");
  // Haiku 5.5 uses its over-100k-prompt tier; Sonnet 4.5 its over-200k tier.
  closeTo(perMillionPair("claude-haiku-5-5"), 0.5 + 2.5, "claude-haiku-5-5");
  closeTo(perMillionPair("claude-sonnet-4-5-20250929"), 6 + 22.5, "claude-sonnet-4-5");
  closeTo(perMillionPair("claude-haiku-4-5-20251001"), 1 + 5, "claude-haiku-4-5");
  // DeepSeek API, peak band, cache-miss input.
  closeTo(perMillionPair("deepseek-flash"), 0.3 + 1.2, "deepseek-flash");
  closeTo(perMillionPair("deepseek-v4-flash"), 0.3 + 1.2, "deepseek-v4-flash alias");
  closeTo(perMillionPair("deepseek-v4-pro"), 1.32 + 3.96, "deepseek-v4-pro");
  // Gemini API, paid standard tier, top prompt-length tier.
  closeTo(perMillionPair("gemini-2.5-pro"), 2.5 + 15, "gemini-2.5-pro");
  closeTo(perMillionPair("gemini-3.1-pro-preview"), 4 + 18, "gemini-3.1-pro-preview");
  closeTo(perMillionPair("gemini-2.5-flash-lite"), 0.1 + 0.4, "gemini-2.5-flash-lite");
});

test("announced price increases are already in the table", () => {
  // Google doubles Gemini 3.6/3.8 Flash on 2027-01-01 and Gemini 4 on 2026-12-01.
  closeTo(perMillionPair("gemini-3.6-flash"), 1.5 + 7.5, "gemini-3.6-flash");
  closeTo(perMillionPair("gemini-3.8-flash"), 1.5 + 7.5, "gemini-3.8-flash");
  closeTo(perMillionPair("gemini-4-carbon"), 4 + 20, "gemini-4-carbon");
  closeTo(perMillionPair("google/gemini-3.8-flash"), 2.7 + 13.5, "or gemini-3.8-flash");
  closeTo(perMillionPair("google/gemini-4-carbon"), 7.2 + 36, "or gemini-4-carbon");
});

test("ids the providers no longer list are not guessed", () => {
  // DeepSeek's pricing page lists deepseek-flash and deepseek-v4-pro only.
  closeTo(perMillionPair("deepseek-reasoner"), 75, "deepseek-reasoner");
  closeTo(perMillionPair("deepseek-chat"), 75, "deepseek-chat");
  closeTo(perMillionPair("claude-3-5-sonnet-20241022"), 75, "claude-3.5-sonnet");
});

test("the pre-call estimate and the free list use the same rows", () => {
  closeTo(pessimisticRequestCostUsd("claude-sonnet-5-5", 1000), 0.01, "estimate");
  // A priced id stays priced on the free list; a dated variant of it keeps the fallback.
  closeTo(perMillionPair("claude-sonnet-5-5", ["claude-sonnet-5-5"]), 12, "free-listed priced id");
  closeTo(perMillionPair("claude-sonnet-5-5-20261101", ["claude-sonnet-5-5-20261101"]), 75, "dated variant");
});
