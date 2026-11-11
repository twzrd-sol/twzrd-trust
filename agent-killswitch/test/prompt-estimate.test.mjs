// The pre-call estimate counts a bound on prompt tokens (one per request
// byte). These tests are offline: a stub upstream on 127.0.0.1:0, no key,
// no network, no spend.
//
// The differential tests compare this tree with test/gate-0.1.10.fixture.mjs,
// the compiled gate of the tree before the bound existed. Cases come from a
// fixed-seed generator (mulberry32), so a failure reproduces exactly.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { budgetInputForChatRequest, chatOutputLimit, createBudgetGate, isTextOnlyPrompt } from "@twzrd1111/agent-killswitch";
import { admissionRequest, createServer } from "../dist/index.js";
import { evaluateGate, requestEstimate } from "../dist/gate.js";
import { costUsd, priceFor } from "../dist/pricing.js";
import { outboundBodyText } from "../dist/proxy.js";

/** Bytes the proxy counts: the larger of what arrived and what it forwards. */
function countedBytes(raw, body) {
  return Math.max(raw.length, Buffer.byteLength(outboundBodyText(body), "utf8"));
}
import * as before from "./gate-0.1.10.fixture.mjs";

const SEED = 0x5eed2026;
const GATE_CASES = 25_000;
const BODY_CASES = 25_000;
const STRING_CASES = 20_000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (items) => items[int(0, items.length - 1)];
  return { next, int, pick, chance: (p) => next() < p };
}

const MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "o1",
  "claude-fable-5-2",
  "nvidia/nemotron-3.5-bolt", // $0 row
  "local-free", // no row; $0 only when on the zero-price list
  "gpt-4o-2024-11-20", // dated id of a priced model: never free
  "some-unknown-model",
  "custom", // priced only by a rate override
];

function randomRates(r) {
  if (r.chance(0.6)) return undefined;
  const rate = () => r.pick([0, 0, 0.15, 2.5, 15, 60, 500, r.next() * 100]);
  return { custom: { inputPerMTok: rate(), outputPerMTok: rate() } };
}

function randomLimits(r) {
  return {
    maxTokensPerMinute: r.pick([0, 1_000, 100_000, 100_000, 5_000_000, 1e12]),
    maxUsdPerHour: r.pick([0, 0.1, 5, 5, 100, 1e9]),
    maxUsdPerDay: r.pick([0, 0.1, 25, 25, 100, 1e9]),
    maxCostPerRequestUsd: r.pick([0, 0.01, 0.5, 0.5, 5, 1e6, r.next() * 2]),
  };
}

function randomWindow(r, limits) {
  const part = (limit) => r.pick([0, 0, limit * r.next(), limit * 0.999, limit, limit * 1.5 + 1]);
  return {
    minuteTokens: Math.floor(part(limits.maxTokensPerMinute)),
    hourUsd: part(limits.maxUsdPerHour),
    dayUsd: part(limits.maxUsdPerDay),
  };
}

function randomMaxTokens(r) {
  if (r.chance(0.3)) return null;
  return r.pick([0, 1, 16, r.int(0, 4_096), r.int(0, 200_000), r.int(0, 5_000_000)]);
}

const INVALID_BYTES = [Number.NaN, -1, -0.5, 1.5, Infinity, -Infinity, 2 ** 53, "100", true, {}, [], 1e400];

/** A prompt size as a gate caller may pass it, valid or not, and whether it is usable. */
function randomPrompt(r) {
  const roll = r.next();
  if (roll < 0.08) return { prompt: undefined, known: false };
  if (roll < 0.14) return { prompt: null, known: false };
  if (roll < 0.2) return { prompt: { bytes: null, textOnly: r.chance(0.5) }, known: false };
  if (roll < 0.32) return { prompt: { bytes: r.pick(INVALID_BYTES), textOnly: r.chance(0.5) }, known: false };
  if (roll < 0.36) return { prompt: r.pick(["100", 100, true, []]), known: false };
  const bytes = r.pick([0, 1, r.int(0, 2_000), r.int(0, 200_000), r.int(0, 10 * 1024 * 1024)]);
  const textOnly = r.pick([true, true, false, "true", 1, undefined]);
  return { prompt: { bytes, textOnly }, known: true };
}

function isFree(model, zeroPriceModels, rates) {
  const { price } = priceFor(model, zeroPriceModels, rates);
  return price.inputPerMTok === 0 && price.outputPerMTok === 0;
}

test(`differential, ${GATE_CASES} seeded gate inputs: the estimate only rises and every refusal is kept`, (t) => {
  const r = makeRng(SEED);
  const seen = {
    cases: 0,
    refusedBefore: 0,
    refusedAfter: 0,
    newlyRefused: 0,
    estimateRose: 0,
    estimateEqual: 0,
    withoutMaxTokens: 0,
    promptUnusable: 0,
  };
  for (let i = 0; i < GATE_CASES; i += 1) {
    const model = r.pick(MODELS);
    const modelRates = randomRates(r);
    const zeroPriceModels = r.pick([null, undefined, [], ["local-free"], ["local-free", "gpt-4o"]]);
    const limits = randomLimits(r);
    const maxTokens = randomMaxTokens(r);
    const { prompt, known } = randomPrompt(r);
    const input = {
      killed: r.chance(0.03),
      paused: r.chance(0.06),
      pauseReason: r.pick([null, "budget_exceeded", "payment_gate_halt"]),
      pauseDecisionId: null,
      window: randomWindow(r, limits),
      model,
      maxTokens,
      ...limits,
      allowedModels: r.chance(0.1) ? ["gpt-4o", "local-free"] : null,
      zeroPriceModels,
      modelRates,
    };
    const label = `case ${i}: ${JSON.stringify({ ...input, prompt: String(JSON.stringify(prompt)) })}`;

    const oldEst = before.requestEstimate(model, maxTokens, limits.maxCostPerRequestUsd, zeroPriceModels, modelRates);
    const newEst = requestEstimate(model, maxTokens, limits.maxCostPerRequestUsd, zeroPriceModels, modelRates, prompt);
    assert.ok(Number.isFinite(newEst.tokens) && Number.isFinite(newEst.usd), `finite estimate, ${label}`);
    assert.ok(newEst.tokens >= oldEst.tokens, `tokens ${newEst.tokens} < ${oldEst.tokens}, ${label}`);
    assert.ok(newEst.usd >= oldEst.usd, `usd ${newEst.usd} < ${oldEst.usd}, ${label}`);

    const free = isFree(model, zeroPriceModels, modelRates);
    // An unusable prompt size, a prompt that is not text-only, or a missing
    // max_tokens never holds less than the per-request cap on a priced model.
    const bounded = known && prompt.textOnly === true;
    if (!free && (!bounded || maxTokens === null)) {
      assert.ok(newEst.usd >= limits.maxCostPerRequestUsd, `below the cap: ${newEst.usd}, ${label}`);
    }
    if (free) assert.equal(newEst.usd, 0, `a $0 model holds no dollars, ${label}`);

    const oldDecision = before.evaluateGate(input);
    const newDecision = evaluateGate({ ...input, prompt });
    if (!oldDecision.allowed) {
      assert.equal(newDecision.allowed, false, `refused before, allowed now, ${label}`);
      // Vetoes that do not depend on the estimate are the same veto.
      if (["kill_switch", "model_not_allowed"].includes(oldDecision.code)) {
        assert.deepEqual(newDecision, oldDecision, label);
      }
    }

    seen.cases += 1;
    if (!oldDecision.allowed) seen.refusedBefore += 1;
    if (!newDecision.allowed) seen.refusedAfter += 1;
    if (oldDecision.allowed && !newDecision.allowed) seen.newlyRefused += 1;
    if (newEst.usd > oldEst.usd || newEst.tokens > oldEst.tokens) seen.estimateRose += 1;
    else seen.estimateEqual += 1;
    if (maxTokens === null) seen.withoutMaxTokens += 1;
    if (!known) seen.promptUnusable += 1;
  }
  assert.equal(seen.cases, GATE_CASES);
  // The generator must exercise both sides, or the loop above proves nothing.
  assert.ok(seen.refusedBefore > 1_000 && seen.refusedBefore < GATE_CASES - 1_000);
  assert.ok(seen.newlyRefused > 0 && seen.estimateRose > 1_000 && seen.promptUnusable > 1_000);
  t.diagnostic(
    `gate differential seed=0x${SEED.toString(16)} ${JSON.stringify(seen)} ` +
      `violations=0 (refused before and allowed now: 0; estimate lower than before: 0)`,
  );
});

// ---------------------------------------------------------------------------
// Request bodies: the proxy's own parse against createBudgetGate.

function randomText(r) {
  const alphabets = [
    "abcdefghijklmnopqrstuvwxyz ",
    "0123456789",
    "\n\t\"\\/{}[]:,",
    "éüñ¿",
    "日本語中文한국",
    "😀🧪",
    "\u0000\u0001\u001f ",
    "\ud83d", // a lone surrogate
  ];
  const alphabet = r.pick(alphabets);
  const length = r.pick([0, 1, r.int(0, 40), r.int(0, 400)]);
  const units = Array.from(alphabet);
  let out = "";
  for (let i = 0; i < length; i += 1) out += r.pick(units);
  return out;
}

function randomContent(r) {
  const roll = r.next();
  if (roll < 0.55) return randomText(r);
  if (roll < 0.62) return null;
  if (roll < 0.8) return [{ type: "text", text: randomText(r) }];
  if (roll < 0.86) return [{ type: "text", text: randomText(r) }, { type: "text", text: randomText(r) }];
  // Not text-only.
  return r.pick([
    [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
    [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }],
    [{ type: "file", file: { file_id: "file-1" } }],
    [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }],
    [{ type: "text" }],
    ["plain string part"],
    42,
    { type: "text", text: "not in an array" },
  ]);
}

function randomMessage(r) {
  const message = { role: r.pick(["system", "user", "assistant", "tool", "developer"]), content: randomContent(r) };
  if (r.chance(0.05)) message.name = "worker";
  if (r.chance(0.05)) message.tool_calls = [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }];
  if (r.chance(0.03)) message.audio = { id: "audio-1" };
  if (r.chance(0.02)) delete message.role;
  return message;
}

const MAX_TOKENS_VALUES = [0, 0.5, 1, 16, 1_000, 8_000, 250_000, 12.7, -1, -1_000_000, "100", null, true];

/**
 * The output limit and text-only flag a createBudgetGate caller should pass for a chat body,
 * written out here without calling the proxy's admissionRequest: the larger of max_tokens and
 * max_completion_tokens (a value below 1 or not a finite number is absent), times n; and not
 * text-only when max_completion_tokens is the only limit.
 */
function callerInputs(sent, body) {
  const limit = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null);
  const classic = limit(sent.max_tokens);
  const completion = limit(sent.max_completion_tokens);
  let maxTokens = classic === null ? completion : Math.max(classic, completion ?? 0);
  if (maxTokens !== null && typeof sent.n === "number" && sent.n > 1) maxTokens *= Math.ceil(sent.n);
  return { maxTokens, promptTextOnly: isTextOnlyPrompt(body) && !(classic === null && completion !== null) };
}

function randomBody(r) {
  const body = { model: r.pick(MODELS) };
  const count = r.pick([0, 1, 2, r.int(0, 6)]);
  body.messages = Array.from({ length: count }, () => randomMessage(r));
  if (r.chance(0.7)) body.max_tokens = r.pick(MAX_TOKENS_VALUES);
  if (r.chance(0.2)) body.temperature = r.next();
  if (r.chance(0.1)) body.stream = r.chance(0.5);
  if (r.chance(0.1)) body.max_completion_tokens = r.pick(MAX_TOKENS_VALUES);
  if (r.chance(0.05)) body.n = r.pick([1, 2, 4, 2.5, 0, "3"]);
  if (r.chance(0.03)) body.service_tier = r.pick(["default", "flex", "priority", "auto"]);
  if (r.chance(0.04)) body.model = `${body.model}${r.pick([":free", ":online", ":online:free", "@preset/p"])}`;
  if (r.chance(0.06)) body.tools = [{ type: "function", function: { name: "f", parameters: {} } }];
  if (r.chance(0.03)) body.response_format = { type: "json_object" };
  if (r.chance(0.03)) body.plugins = [{ id: "web" }];
  if (r.chance(0.02)) body.messages = r.pick([null, "hi", { role: "user", content: "hi" }]);
  return body;
}

/** The bytes a client might send for `body`: compact, indented, or with every non-ASCII unit escaped. */
function serialize(r, body) {
  const roll = r.next();
  if (roll < 0.6) return JSON.stringify(body);
  if (roll < 0.8) return JSON.stringify(body, null, r.int(1, 4));
  return JSON.stringify(body).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

test(`differential, ${BODY_CASES} seeded request bodies: proxy and createBudgetGate agree, and neither is below 0.1.10`, (t) => {
  const r = makeRng(SEED ^ 0x9e3779b9);
  const seen = {
    cases: 0,
    textOnly: 0,
    notTextOnly: 0,
    refusedBefore: 0,
    refusedAfter: 0,
    newlyRefused: 0,
    maxTokensUnusable: 0,
  };
  for (let i = 0; i < BODY_CASES; i += 1) {
    const sent = randomBody(r);
    const raw = Buffer.from(serialize(r, sent), "utf8");
    const limits = randomLimits(r);
    const window = randomWindow(r, limits);
    const modelRates = randomRates(r);
    const zeroPriceModels = r.pick([[], ["local-free"]]);
    const label = `case ${i}: ${raw.toString("utf8").slice(0, 300)} limits=${JSON.stringify(limits)}`;

    // Proxy side: exactly what handle() does with the bytes it read.
    const body = JSON.parse(raw.toString("utf8"));
    const req = admissionRequest(body, raw.length);
    const proxyEst = requestEstimate(
      req.model, req.maxTokens, limits.maxCostPerRequestUsd, zeroPriceModels, modelRates, req.prompt);
    const proxyDecision = evaluateGate({
      killed: false, paused: false, pauseReason: null, pauseDecisionId: null, window,
      model: req.model, maxTokens: req.maxTokens, prompt: req.prompt, ...limits,
      allowedModels: null, zeroPriceModels, modelRates,
    });

    // createBudgetGate side, from the same request, computed without the proxy's parse.
    const m = sent.max_tokens;
    const apiRequest = {
      model: sent.model,
      ...callerInputs(sent, body),
      promptBytes: countedBytes(raw, body),
      zeroPriceModels,
    };
    const usable = apiRequest.maxTokens !== null;
    const gate = createBudgetGate({ ...limits, modelRates });
    assert.deepEqual(gate.estimate(apiRequest), proxyEst, `estimate differs, ${label}`);
    assert.deepEqual(gate.evaluate({ ...apiRequest, window }), proxyDecision, `decision differs, ${label}`);

    // Against 0.1.10, with 0.1.10's own reading of max_tokens (any finite number, floored).
    const oldMax = typeof m === "number" && Number.isFinite(m) ? Math.floor(m) : null;
    const oldEst = before.requestEstimate(sent.model, oldMax, limits.maxCostPerRequestUsd, zeroPriceModels, modelRates);
    const oldDecision = before.evaluateGate({
      killed: false, paused: false, pauseReason: null, pauseDecisionId: null, window,
      model: sent.model, maxTokens: oldMax, ...limits, allowedModels: null, zeroPriceModels, modelRates,
    });
    assert.ok(proxyEst.tokens >= oldEst.tokens, `tokens ${proxyEst.tokens} < ${oldEst.tokens}, ${label}`);
    assert.ok(proxyEst.usd >= oldEst.usd, `usd ${proxyEst.usd} < ${oldEst.usd}, ${label}`);
    assert.ok(proxyEst.tokens >= raw.length, `the token hold covers every request byte, ${label}`);
    assert.ok(proxyEst.usd >= 0, `never a negative hold, ${label}`);
    if (!oldDecision.allowed) assert.equal(proxyDecision.allowed, false, `refused before, allowed now, ${label}`);
    if (!isFree(sent.model, zeroPriceModels, modelRates) && (!req.prompt.textOnly || req.maxTokens === null)) {
      assert.ok(proxyEst.usd >= limits.maxCostPerRequestUsd, `below the cap, ${label}`);
    }

    seen.cases += 1;
    if (req.prompt.textOnly) seen.textOnly += 1;
    else seen.notTextOnly += 1;
    if (!oldDecision.allowed) seen.refusedBefore += 1;
    if (!proxyDecision.allowed) seen.refusedAfter += 1;
    if (oldDecision.allowed && !proxyDecision.allowed) seen.newlyRefused += 1;
    if (m !== undefined && !usable) seen.maxTokensUnusable += 1;
  }
  assert.equal(seen.cases, BODY_CASES);
  assert.ok(seen.textOnly > 1_000 && seen.notTextOnly > 1_000 && seen.refusedBefore > 1_000);
  assert.ok(seen.maxTokensUnusable > 1_000);
  t.diagnostic(
    `body differential seed=0x${((SEED ^ 0x9e3779b9) >>> 0).toString(16)} ${JSON.stringify(seen)} ` +
      `violations=0 (proxy and createBudgetGate estimates differ: 0; decisions differ: 0; ` +
      `refused before and allowed now: 0; estimate lower than before: 0)`,
  );
});

test(`${STRING_CASES} seeded strings: a JSON string is never shorter than the UTF-8 text it decodes to`, (t) => {
  // The step of the bound that can be checked without a tokenizer: the text
  // an upstream tokenizes is no longer, in bytes, than its JSON encoding in
  // the request, however the client escaped it.
  const r = makeRng(SEED ^ 0x1234567);
  let checked = 0;
  for (let i = 0; i < STRING_CASES; i += 1) {
    const text = randomText(r);
    const encodings = [
      JSON.stringify(text),
      // Every code unit as a \uXXXX escape, and the short escapes JSON allows.
      `"${Array.from({ length: text.length }, (_, k) => `\\u${text.charCodeAt(k).toString(16).padStart(4, "0")}`).join("")}"`,
    ];
    for (const encoded of encodings) {
      const decoded = JSON.parse(encoded);
      assert.equal(decoded, text);
      assert.ok(
        Buffer.byteLength(decoded, "utf8") <= Buffer.byteLength(encoded, "utf8") - 2,
        `decoded text is longer than its JSON encoding: ${encoded.slice(0, 80)}`,
      );
      checked += 1;
    }
  }
  for (const [encoded, decoded] of [['"\\n\\t\\"\\\\\\/\\b\\f\\r"', '\n\t"\\/\b\f\r'], ['"\\ud83d\\ude00"', "😀"]]) {
    assert.equal(JSON.parse(encoded), decoded);
    assert.ok(Buffer.byteLength(decoded, "utf8") <= Buffer.byteLength(encoded, "utf8") - 2);
  }
  t.diagnostic(`json encodings checked=${checked} longer-than-encoding=0`);
});

// ---------------------------------------------------------------------------
// Named cases.

test("isTextOnlyPrompt accepts plain text chats and nothing else", () => {
  const user = (content) => ({ role: "user", content });
  const yes = [
    { model: "gpt-4o", messages: [] },
    { model: "gpt-4o", messages: [user("hi")], max_tokens: 10, temperature: 0, stream: true, stream_options: {} },
    { model: "gpt-4o", messages: [{ role: "system", content: "s" }, user([{ type: "text", text: "hi" }])] },
    { model: "gpt-4o", messages: [{ role: "assistant", content: null, tool_calls: [] }, { role: "tool", tool_call_id: "c", content: "{}" }] },
    { model: "gpt-4o", messages: [{ role: "assistant" }], n: 1, stop: ["x"], seed: 1, user: "u", request_id: "r", service_tier: "default" },
  ];
  const no = [
    null,
    undefined,
    "text",
    [],
    {},
    { model: "gpt-4o" },
    { model: "gpt-4o", messages: "hi" },
    { model: "gpt-4o", messages: ["hi"] },
    { model: "gpt-4o", messages: [{ content: "no role" }] },
    { model: "gpt-4o", messages: [user(7)] },
    { model: "gpt-4o", messages: [user({ type: "text", text: "x" })] },
    { model: "gpt-4o", messages: [user([{ type: "image_url", image_url: { url: "https://example.com/a.png" } }])] },
    { model: "gpt-4o", messages: [user([{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "data:," } }])] },
    { model: "gpt-4o", messages: [user([{ type: "input_audio", input_audio: { data: "", format: "wav" } }])] },
    { model: "gpt-4o", messages: [user([{ type: "file", file: { file_id: "f" } }])] },
    { model: "gpt-4o", messages: [user([{ type: "text", text: 5 }])] },
    { model: "gpt-4o", messages: [user([{ type: "text", text: "x", extra: 1 }])] },
    { model: "gpt-4o", messages: [{ role: "assistant", content: "x", audio: { id: "a" } }] },
    { model: "gpt-4o", messages: [user("hi")], tools: [] },
    { model: "gpt-4o", messages: [user("hi")], functions: [] },
    { model: "gpt-4o", messages: [user("hi")], response_format: { type: "json_object" } },
    { model: "gpt-4o", messages: [user("hi")], web_search_options: {} },
    { model: "gpt-4o", messages: [user("hi")], some_future_field: 1 },
  ];
  for (const body of yes) assert.equal(isTextOnlyPrompt(body), true, JSON.stringify(body));
  for (const body of no) assert.equal(isTextOnlyPrompt(body), false, JSON.stringify(body));
});

test("requestEstimate: one prompt token per byte, at the input rate", () => {
  const text = { bytes: 40_000, textOnly: true };
  // gpt-4o: $2.50 input, $10 output per 1M.
  assert.deepEqual(requestEstimate("gpt-4o", 1_000, 0.5, null, undefined, text), {
    tokens: 41_000,
    usd: (1_000 * 10 + 40_000 * 2.5) / 1_000_000,
  });
  // Without max_tokens the cap still stands, and the prompt bound replaces it only when higher.
  assert.deepEqual(requestEstimate("gpt-4o", null, 0.5, null, undefined, text), { tokens: 40_000, usd: 0.5 });
  assert.deepEqual(requestEstimate("gpt-4o", null, 0.05, null, undefined, text), { tokens: 40_000, usd: 0.1 });
  // Not text-only: the bytes still count, and the dollars are never below the cap.
  const mixed = { bytes: 40_000, textOnly: false };
  assert.deepEqual(requestEstimate("gpt-4o", 1_000, 0.5, null, undefined, mixed), { tokens: 41_000, usd: 0.5 });
  assert.deepEqual(requestEstimate("gpt-4o", 1_000, 0.05, null, undefined, mixed), { tokens: 41_000, usd: 0.11 });
  // A $0 model holds tokens and no dollars.
  assert.deepEqual(requestEstimate("local", 1_000, 0.5, ["local"], undefined, mixed), { tokens: 41_000, usd: 0 });
});

test("requestEstimate: an absent or invalid prompt size falls back to the per-request cap", () => {
  const cap = 0.5;
  const low = (1_000 * 10) / 1_000_000; // what 0.1.10 held: max_tokens only
  const unusable = [
    undefined,
    null,
    "100",
    100,
    {},
    { bytes: null, textOnly: true },
    { textOnly: true },
    ...INVALID_BYTES.map((bytes) => ({ bytes, textOnly: true })),
  ];
  for (const prompt of unusable) {
    const est = requestEstimate("gpt-4o", 1_000, cap, null, undefined, prompt);
    assert.deepEqual(est, { tokens: 1_000, usd: cap }, `prompt ${String(JSON.stringify(prompt))}`);
    assert.ok(est.usd > low);
  }
  // textOnly must be exactly true.
  for (const textOnly of [false, undefined, null, "true", 1, {}]) {
    assert.equal(requestEstimate("gpt-4o", 1_000, cap, null, undefined, { bytes: 10, textOnly }).usd, cap);
  }
  // +Infinity keeps an unbounded estimate, so every limit still refuses it (0.1.10 did).
  assert.deepEqual(
    requestEstimate("gpt-4o", Infinity, cap, null, undefined, { bytes: 10, textOnly: true }),
    { tokens: Infinity, usd: Infinity },
  );
  // A max_tokens that is negative, NaN or not a number is treated as absent.
  for (const maxTokens of [Number.NaN, -1, -1e9, "5"]) {
    const est = requestEstimate("gpt-4o", maxTokens, cap, null, undefined, { bytes: 10, textOnly: true });
    assert.deepEqual(est, { tokens: 10, usd: cap }, `maxTokens ${String(maxTokens)}`);
  }
});

test("createBudgetGate: a malformed prompt size throws; an absent one holds the cap", () => {
  const gate = createBudgetGate({
    maxTokensPerMinute: 100_000,
    maxUsdPerHour: 5,
    maxUsdPerDay: 25,
    maxCostPerRequestUsd: 0.5,
  });
  const window = { minuteTokens: 0, hourUsd: 0, dayUsd: 0 };
  const base = { model: "gpt-4o", maxTokens: 1_000 };
  for (const promptBytes of INVALID_BYTES) {
    assert.throws(() => gate.estimate({ ...base, promptBytes }), /promptBytes must be null or a non-negative safe integer/);
    assert.throws(
      () => gate.evaluate({ ...base, window, promptBytes, promptTextOnly: true }),
      /promptBytes must be null or a non-negative safe integer/,
    );
  }
  for (const promptTextOnly of ["true", 1, {}]) {
    assert.throws(() => gate.estimate({ ...base, promptBytes: 10, promptTextOnly }), /promptTextOnly must be a boolean/);
  }
  assert.deepEqual(gate.estimate(base), { tokens: 1_000, usd: 0.5 });
  assert.deepEqual(gate.estimate({ ...base, promptBytes: null }), { tokens: 1_000, usd: 0.5 });
  assert.deepEqual(gate.estimate({ ...base, promptBytes: 4_000 }), { tokens: 5_000, usd: 0.5 });
  assert.deepEqual(gate.estimate({ ...base, promptBytes: 4_000, promptTextOnly: true }), { tokens: 5_000, usd: 0.02 });

  // The documented gap: a large text prompt with a small max_tokens.
  const big = { model: "gpt-4o", maxTokens: 16, promptBytes: 400_000, promptTextOnly: true };
  const decision = gate.evaluate({ ...big, window });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "budget_exceeded"); // 400,016 tokens against 100,000 per minute
  const roomy = createBudgetGate({ maxTokensPerMinute: 1e9, maxUsdPerHour: 5, maxUsdPerDay: 25, maxCostPerRequestUsd: 0.5 });
  const capped = roomy.evaluate({ ...big, window });
  assert.equal(capped.code, "per_request_cap"); // 400,000 bytes * $2.50/1M = $1.00 > $0.50
  assert.equal(capped.status, 429);
});

// ---------------------------------------------------------------------------
// Through the proxy.

const ORIGINAL_CWD = process.cwd();
let dir;
let upstream;
let servers;

function startUpstream() {
  const state = { hits: 0, usage: null, lastBytes: 0 };
  const server = http.createServer((req, res) => {
    let received = 0;
    req.on("data", (c) => {
      received += c.length;
    });
    req.on("end", () => {
      state.hits += 1;
      state.lastBytes = received;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          choices: [{ message: { role: "assistant", content: "hi" } }],
          ...(state.usage ? { usage: state.usage } : {}),
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "killswitch-prompt-"));
  process.chdir(dir);
  for (const k of Object.keys(process.env)) if (k.startsWith("KILLSWITCH_")) delete process.env[k];
  upstream = await startUpstream();
  process.env.OPENAI_API_KEY = "sk-test-offline";
  process.env.KILLSWITCH_UPSTREAM_BASE_URL = `http://127.0.0.1:${upstream.port}/v1`;
  servers = [];
});

afterEach(async () => {
  for (const s of servers) await close(s);
  await close(upstream.server);
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function startKillswitch() {
  const server = createServer();
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** POST the exact bytes of `raw` (a string or Buffer). */
async function post(port, raw) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  return { status: res.status, json: await res.json() };
}

function readLedger() {
  const file = path.join(dir, "data", "spend-ledger.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("proxy: a large text prompt with a small max_tokens is refused before upstream", async () => {
  process.env.KILLSWITCH_MAX_TOKENS_MINUTE = "100000000";
  const port = await startKillswitch();
  // 300 kB of text on gpt-4o: 300,000 prompt tokens at most, $0.75 at $2.50/1M, over the $0.50 cap.
  const raw = JSON.stringify({ model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "a".repeat(300_000) }] });
  const r = await post(port, raw);
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "per_request_cap");
  assert.equal(upstream.state.hits, 0);
  // The same prompt without max_tokens is refused too: dropping the field is not a way around the check.
  const r2 = await post(port, JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "a".repeat(300_000) }] }));
  assert.equal(r2.status, 429);
  assert.equal(r2.json.error.code, "per_request_cap");
  assert.equal(upstream.state.hits, 0);
  // With the default 100,000 tokens per minute the token check refuses it first.
  delete process.env.KILLSWITCH_MAX_TOKENS_MINUTE;
  process.env.KILLSWITCH_PAUSE_FILE = path.join(dir, ".pause");
  const port2 = await startKillswitch();
  const r3 = await post(port2, raw);
  assert.equal(r3.status, 429);
  assert.equal(r3.json.error.code, "budget_exceeded");
  assert.match(r3.json.error.message, /over the token-per-minute limit 100000; waiting will not help/);
  // A request that can never fit sets no backpressure pause.
  assert.equal(fs.existsSync(path.join(dir, ".pause")), false);
  assert.equal(upstream.state.hits, 0);
});

test("proxy: the held estimate written to the ledger is createBudgetGate's estimate for the same bytes", async (t) => {
  // The upstream answers 200 without usage, so every allowed call is ledgered at its hold.
  process.env.KILLSWITCH_MAX_TOKENS_MINUTE = "1000000000";
  process.env.KILLSWITCH_MAX_USD_HOUR = "1000000";
  process.env.KILLSWITCH_MAX_USD_DAY = "1000000";
  process.env.KILLSWITCH_MAX_COST_REQUEST = "0.5";
  const port = await startKillswitch();
  const gate = createBudgetGate({
    maxTokensPerMinute: 1e9, maxUsdPerHour: 1e6, maxUsdPerDay: 1e6, maxCostPerRequestUsd: 0.5,
  });
  const r = makeRng(SEED ^ 0x777);
  let allowed = 0;
  let refused = 0;
  for (let i = 0; i < 150; i += 1) {
    const sent = randomBody(r);
    const raw = Buffer.from(serialize(r, sent), "utf8");
    const m = sent.max_tokens;
    const expected = gate.estimate({
      model: sent.model,
      ...callerInputs(sent, JSON.parse(raw.toString("utf8"))),
      promptBytes: countedBytes(raw, JSON.parse(raw.toString("utf8"))),
      zeroPriceModels: [],
    });
    const linesBefore = readLedger().length;
    const res = await post(port, raw);
    const line = readLedger().at(-1);
    assert.equal(readLedger().length, linesBefore + 1);
    if (expected.usd > 0.5) {
      assert.equal(res.status, 429, `case ${i}`);
      assert.equal(line.veto_reason, "per_request_cap");
      refused += 1;
    } else {
      assert.equal(res.status, 200, `case ${i}: ${JSON.stringify(res.json)}`);
      assert.equal(line.metered, "held_estimate");
      assert.equal(line.total_tokens, expected.tokens, `case ${i}`);
      assert.equal(line.cost_usd, expected.usd, `case ${i}`);
      allowed += 1;
    }
  }
  assert.ok(allowed > 50, `allowed ${allowed}`);
  t.diagnostic(`proxy held_estimate rows equal to createBudgetGate.estimate: ${allowed}; refused per_request_cap: ${refused}`);
});

test("proxy: an image part or a negative max_tokens holds the per-request cap", async () => {
  const port = await startKillswitch();
  const image = {
    model: "gpt-4o-mini",
    max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
  };
  const a = await post(port, JSON.stringify(image));
  assert.equal(a.status, 200);
  const negative = { model: "gpt-4o-mini", max_tokens: -1_000_000, messages: [] };
  const b = await post(port, JSON.stringify(negative));
  assert.equal(b.status, 200);
  const lines = readLedger();
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.metered, "held_estimate");
    assert.equal(line.cost_usd, 0.5);
  }
  assert.equal(lines[0].total_tokens, 100 + Buffer.byteLength(JSON.stringify(image)));
  assert.equal(lines[1].total_tokens, Buffer.byteLength(JSON.stringify(negative)));
});

test("proxy: settlement from upstream usage is unchanged by the larger hold", async () => {
  upstream.state.usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
  const port = await startKillswitch();
  const raw = JSON.stringify({ model: "gpt-4o-mini", max_tokens: 4000, messages: [{ role: "user", content: "x".repeat(20_000) }] });
  const r = await post(port, raw);
  assert.equal(r.status, 200);
  const lines = readLedger();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].metered, "usage");
  assert.equal(lines[0].prompt_tokens, 1000);
  assert.equal(lines[0].completion_tokens, 500);
  assert.equal(lines[0].total_tokens, 1500);
  assert.equal(lines[0].cost_usd, costUsd("gpt-4o-mini", 1000, 500));
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.hour_usd, costUsd("gpt-4o-mini", 1000, 500));
  assert.equal(health.in_flight, 0);
});

// ---------------------------------------------------------------------------
// Review findings on the first version of this change.

test("proxy: the count is of the bytes forwarded, not the bytes received (invalid UTF-8 triples)", async () => {
  process.env.KILLSWITCH_MAX_TOKENS_MINUTE = "1000000000";
  process.env.KILLSWITCH_MAX_USD_HOUR = "1000000";
  process.env.KILLSWITCH_MAX_USD_DAY = "1000000";
  process.env.KILLSWITCH_MAX_COST_REQUEST = "100";
  const port = await startKillswitch();
  // 30,000 bytes of 0xFF inside the message content: each decodes to U+FFFD,
  // which is 3 bytes when the proxy re-serializes the body for the upstream.
  const head = Buffer.from('{"model":"gpt-4o","max_tokens":1,"messages":[{"role":"user","content":"', "utf8");
  const tail = Buffer.from('"}]}', "utf8");
  const raw = Buffer.concat([head, Buffer.alloc(30_000, 0xff), tail]);
  const res = await post(port, raw);
  assert.equal(res.status, 200);
  assert.equal(upstream.state.hits, 1);
  assert.ok(upstream.state.lastBytes >= 90_000, `upstream received ${upstream.state.lastBytes} bytes`);
  const line = readLedger().at(-1);
  assert.equal(line.metered, "held_estimate");
  // The hold covers every byte the upstream received, plus max_tokens.
  assert.equal(line.total_tokens, upstream.state.lastBytes + 1);
  assert.ok(line.total_tokens > raw.length * 2, `held ${line.total_tokens} for ${raw.length} received bytes`);
});

test("admissionRequest: the counted size is never below the received or the forwarded size", () => {
  const cases = [
    { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true },
    { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], temperature: 1e21, seed: 1e20 },
    { model: "gpt-4o", messages: [] },
  ];
  for (const body of cases) {
    const compact = Buffer.byteLength(JSON.stringify(body));
    for (const rawBytes of [0, compact, compact + 500]) {
      const req = admissionRequest(body, rawBytes);
      assert.equal(Buffer.byteLength(req.outboundText), Buffer.byteLength(outboundBodyText(body)));
      assert.ok(req.prompt.bytes >= rawBytes);
      assert.ok(req.prompt.bytes >= Buffer.byteLength(req.outboundText));
    }
  }
  // A number written in exponent form is forwarded in full.
  const grown = JSON.parse('{"model":"gpt-4o","messages":[],"seed":1e20}');
  assert.ok(admissionRequest(grown, 44).prompt.bytes > 44);
});

test("isTextOnlyPrompt: message fields must have the exact text shape, not only an allowed name", () => {
  const base = (message) => ({ model: "gpt-4o", messages: [{ role: "user", content: "x", ...message }] });
  const call = { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } };
  assert.equal(isTextOnlyPrompt(base({ name: "bob" })), true);
  assert.equal(isTextOnlyPrompt(base({ tool_call_id: "call_1" })), true);
  assert.equal(isTextOnlyPrompt(base({ refusal: null })), true);
  assert.equal(isTextOnlyPrompt(base({ tool_calls: [call] })), true);
  assert.equal(isTextOnlyPrompt(base({ function_call: { name: "f", arguments: "{}" } })), true);
  for (const bad of [
    { name: 1e20 },
    { name: { url: "https://example.invalid/x" } },
    { tool_call_id: 7 },
    { refusal: [1, 2] },
    { tool_calls: "x" },
    { tool_calls: [{ ...call, type: "custom" }] },
    { tool_calls: [{ ...call, id: 1 }] },
    { tool_calls: [{ ...call, extra: true }] },
    { tool_calls: [{ ...call, function: { name: "f", arguments: { a: 1e20 } } }] },
    { tool_calls: [{ ...call, function: { name: "f", arguments: "{}", file: "file-1" } }] },
    { function_call: { name: 1, arguments: "{}" } },
    { function_call: "auto" },
  ]) {
    assert.equal(isTextOnlyPrompt(base(bad)), false, JSON.stringify(bad));
  }
});

test("isTextOnlyPrompt: an unknown model suffix ends the bound; routing and price suffixes do not", () => {
  const body = (model) => ({ model, messages: [{ role: "user", content: "x" }] });
  for (const model of ["gpt-4o", "meta-llama/llama-3.2-3b-instruct:free", "openai/gpt-4o:nitro", "a/b:floor"]) {
    assert.equal(isTextOnlyPrompt(body(model)), true, model);
  }
  for (const model of [
    "openai/gpt-4o:online", "openai/gpt-4o:free:online", "openai/gpt-4o:online:free", "openai/gpt-4o:online:nitro",
    "@preset/research", "openai/gpt-4o@preset/research", "qwen3:14b", "x:", "", 5, null, undefined,
  ]) {
    assert.equal(isTextOnlyPrompt(body(model)), false, String(model));
  }
  // Through the proxy's own reading of the body: a variant holds at least the cap, a routing suffix does not.
  const cap = 0.5;
  const hold = (model) => {
    const req = admissionRequest({ ...body(model), max_tokens: 1 }, 0);
    return requestEstimate(req.model, req.maxTokens, cap, null, undefined, req.prompt).usd;
  };
  assert.ok(hold("openai/gpt-4o:online:free") >= cap);
  assert.ok(hold("openai/gpt-4o@preset/research") >= cap);
  assert.ok(hold("openai/gpt-4o:nitro") < cap);
});

test("evaluateGate: a request over the per-minute limit on its own is refused without a pause", () => {
  const input = {
    killed: false, paused: false, pauseReason: null, pauseDecisionId: null,
    window: { minuteTokens: 0, hourUsd: 0, dayUsd: 0 },
    model: "gpt-4o", maxTokens: 10, prompt: { bytes: 200, textOnly: true },
    maxTokensPerMinute: 100, maxUsdPerHour: 1e6, maxUsdPerDay: 1e6, maxCostPerRequestUsd: 1e6,
    allowedModels: null, zeroPriceModels: [], modelRates: undefined,
  };
  const alone = evaluateGate(input);
  assert.equal(alone.allowed, false);
  assert.equal(alone.code, "budget_exceeded");
  assert.equal(alone.pauseWindowMs, undefined);
  // It fits on its own but not on top of the window: the 60 s pause is kept.
  const crowded = evaluateGate({ ...input, prompt: { bytes: 50, textOnly: true }, window: { minuteTokens: 60, hourUsd: 0, dayUsd: 0 } });
  assert.equal(crowded.allowed, false);
  assert.equal(crowded.pauseWindowMs, 60_000);
  // An unbounded max_tokens is still refused, as in 0.1.10.
  assert.equal(evaluateGate({ ...input, maxTokens: Infinity, maxTokensPerMinute: 1e12 }).allowed, false);
});

test("admissionRequest: the output limit is the larger of max_tokens and max_completion_tokens, times n", () => {
  const cap = 0.5;
  const base = { model: "o1", messages: [{ role: "user", content: "hi" }] };
  const read = (extra) => {
    const req = admissionRequest({ ...base, ...extra }, 0);
    return { ...req, est: requestEstimate(req.model, req.maxTokens, cap, null, undefined, req.prompt) };
  };
  // Both fields: the larger one is the limit, and the hold covers it.
  const both = read({ max_tokens: 1, max_completion_tokens: 100_000 });
  assert.equal(both.maxTokens, 100_000);
  assert.ok(both.est.usd >= costUsd("o1", 0, 100_000));
  assert.equal(read({ max_tokens: 500, max_completion_tokens: 20 }).maxTokens, 500);
  // max_completion_tokens alone: counted, and never below the cap that 0.1.10 held.
  const small = read({ max_completion_tokens: 10 });
  assert.equal(small.maxTokens, 10);
  assert.equal(small.prompt.textOnly, false);
  assert.ok(small.est.usd >= cap);
  const large = read({ max_completion_tokens: 1_000_000 });
  assert.ok(large.est.usd >= costUsd("o1", 0, 1_000_000));
  assert.ok(large.est.tokens >= 1_000_000);
  // n completions bill n times the output; the request also loses the text-only estimate.
  const many = read({ max_tokens: 4096, n: 128 });
  assert.equal(many.maxTokens, 4096 * 128);
  assert.equal(many.prompt.textOnly, false);
  assert.ok(many.est.usd >= costUsd("o1", 0, 4096 * 128));
  assert.equal(read({ max_tokens: 100, n: 1 }).maxTokens, 100);
  assert.equal(read({ max_tokens: 100, n: 1 }).prompt.textOnly, true);
  assert.equal(read({ max_tokens: 100, n: 2.5 }).maxTokens, 300);
  for (const n of [0, -1, "3", null, 2]) assert.equal(isTextOnlyPrompt({ ...base, n }), false, String(n));
  // An explicit 0 (or anything below 1) is no limit: the cap is held, as with no max_tokens.
  for (const zero of [0, 0.5, -3]) {
    const none = read({ max_tokens: zero });
    assert.equal(none.maxTokens, null, String(zero));
    assert.ok(none.est.usd >= cap);
  }
});

test("isTextOnlyPrompt: a service tier that can bill above the standard row ends the bound", () => {
  const body = (service_tier) => ({ model: "gpt-4o", messages: [{ role: "user", content: "x" }], service_tier });
  for (const tier of ["default", "flex", undefined]) assert.equal(isTextOnlyPrompt(body(tier)), true, String(tier));
  for (const tier of ["priority", "auto", "scale", "", null, 1]) assert.equal(isTextOnlyPrompt(body(tier)), false, String(tier));
});

test("evaluateGate: an oversized request, or one that does not fit the current minute, against a spent hour or day still writes the long pause", () => {
  const input = {
    killed: false, paused: false, pauseReason: null, pauseDecisionId: null,
    window: { minuteTokens: 0, hourUsd: 11, dayUsd: 11 },
    model: "gpt-4o", maxTokens: 16, prompt: { bytes: 150_000, textOnly: true },
    maxTokensPerMinute: 100_000, maxUsdPerHour: 10, maxUsdPerDay: 50, maxCostPerRequestUsd: 0.5,
    allowedModels: null, zeroPriceModels: [], modelRates: undefined,
  };
  const room = { minuteTokens: 0, hourUsd: 1, dayUsd: 1 };
  // Over the per-minute limit on its own, and the hour is spent: the hourly refusal and pause, as 0.1.10 gave.
  const hour = evaluateGate(input);
  assert.equal(hour.pauseWindowMs, 3_600_000);
  assert.deepEqual(hour, before.evaluateGate(input));
  const day = evaluateGate({ ...input, window: { minuteTokens: 0, hourUsd: 0, dayUsd: 55 } });
  assert.equal(day.pauseWindowMs, 86_400_000);
  // Fits the per-minute limit alone but not with the current minute, hour or day spent: the long pause, not 60 s.
  const crowded = { ...input, prompt: { bytes: 50_000, textOnly: true }, window: { minuteTokens: 60_000, hourUsd: 11, dayUsd: 11 } };
  assert.deepEqual(evaluateGate(crowded), before.evaluateGate(crowded));
  assert.equal(evaluateGate(crowded).pauseWindowMs, 3_600_000);
  const crowdedDay = { ...crowded, window: { minuteTokens: 60_000, hourUsd: 0, dayUsd: 55 } };
  assert.deepEqual(evaluateGate(crowdedDay), before.evaluateGate(crowdedDay));
  assert.equal(evaluateGate(crowdedDay).pauseWindowMs, 86_400_000);
  // With room in the budget, the crowded minute keeps its 60 s pause.
  assert.equal(evaluateGate({ ...crowded, window: { ...room, minuteTokens: 60_000 } }).pauseWindowMs, 60_000);
  // Over the per-request cap on its own (token limit raised), hour spent: same.
  const big = { ...input, maxTokensPerMinute: 1e9, prompt: { bytes: 300_000, textOnly: true } };
  assert.equal(evaluateGate(big).pauseWindowMs, 3_600_000);
  // The output limit alone over the cap, hour spent: still the hourly pause (the budget is spent either way).
  assert.equal(evaluateGate({ ...input, maxTokens: 1_000_000, maxTokensPerMinute: 1e12 }).pauseWindowMs, 3_600_000);
  assert.equal(evaluateGate({ ...input, maxTokens: null, maxTokensPerMinute: 1e12, prompt: { bytes: 1e6, textOnly: true } }).pauseWindowMs, 3_600_000);
  // A $0 model with the hour exactly at its limit: "limit hit", as 0.1.10 gave.
  const free = { ...input, model: "local-free", zeroPriceModels: ["local-free"], maxTokens: null, window: { minuteTokens: 0, hourUsd: 10, dayUsd: 10 } };
  assert.equal(evaluateGate(free).pauseWindowMs, 3_600_000);
  assert.equal(before.evaluateGate(free).pauseWindowMs, 3_600_000);
  // The budget has room: the oversized request is refused with no pause, whatever its output limit.
  assert.equal(evaluateGate({ ...input, window: room }).pauseWindowMs, undefined);
  assert.equal(evaluateGate({ ...big, window: room }).code, "per_request_cap");
  assert.equal(evaluateGate({ ...big, window: room }).pauseWindowMs, undefined);
  const roomLeft = { minuteTokens: 0, hourUsd: 9.6, dayUsd: 9.6 };
  assert.equal(evaluateGate({ ...input, maxTokens: 800_000, window: roomLeft }).pauseWindowMs, undefined);
  // Unbounded output never takes the long pause on a budget with room.
  assert.equal(evaluateGate({ ...input, maxTokens: Infinity, window: room }).pauseWindowMs, undefined);
});


test("proxy: a token-per-minute refusal never shortens a longer budget pause already in force", async () => {
  process.env.KILLSWITCH_MAX_USD_HOUR = "1000";
  process.env.KILLSWITCH_MAX_USD_DAY = "1000";
  const pauseFile = path.join(dir, ".pause");
  process.env.KILLSWITCH_PAUSE_FILE = pauseFile;
  const port = await startKillswitch();
  // Fill the current minute with 60,000 settled tokens.
  upstream.state.usage = { prompt_tokens: 59_990, completion_tokens: 10, total_tokens: 60_000 };
  const first = await post(port, JSON.stringify({ model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(first.status, 200);
  // 50 kB of text fits the 100,000 per-minute limit alone, not with the 60,000 already counted.
  const crowding = JSON.stringify({ model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "a".repeat(50_000) }] });
  // An hourly budget pause is in force: the 60 s refusal leaves it as it is.
  const hourUntil = Date.now() + 3_600_000;
  fs.writeFileSync(pauseFile, JSON.stringify({ schema: "twzrd.pause_sentinel.v1", until_unix_ms: hourUntil, reason: "budget_exceeded", decision_id: "hour" }) + "\n");
  const r = await post(port, crowding);
  assert.equal(r.status, 429);
  assert.match(r.json.error.message, /Token-per-minute limit 100000 would be exceeded/);
  const kept = JSON.parse(fs.readFileSync(pauseFile, "utf8"));
  assert.equal(kept.until_unix_ms, hourUntil);
  assert.equal(kept.decision_id, "hour");
  // A pause that ends sooner than 60 s from now is extended to the 60 s window, as before.
  const soon = Date.now() + 5_000;
  fs.writeFileSync(pauseFile, JSON.stringify({ schema: "twzrd.pause_sentinel.v1", until_unix_ms: soon, reason: "budget_exceeded" }) + "\n");
  const before60 = Date.now();
  await post(port, crowding);
  const extended = JSON.parse(fs.readFileSync(pauseFile, "utf8"));
  assert.ok(extended.until_unix_ms >= before60 + 60_000, "the 60 s pause replaces a shorter one");
  // No pause in force: the 60 s pause is written, as in 0.1.10.
  fs.rmSync(pauseFile);
  const before60b = Date.now();
  await post(port, crowding);
  const fresh = JSON.parse(fs.readFileSync(pauseFile, "utf8"));
  assert.ok(fresh.until_unix_ms >= before60b + 60_000 && fresh.until_unix_ms <= Date.now() + 60_000);
  assert.equal(upstream.state.hits, 1);
});

test("budgetInputForChatRequest: a createBudgetGate caller holds what the proxy holds for the same text", () => {
  const cap = 0.5;
  const gate = createBudgetGate({ maxTokensPerMinute: 1e12, maxUsdPerHour: 1e9, maxUsdPerDay: 1e9, maxCostPerRequestUsd: cap });
  const proxyHold = (text) => {
    const req = admissionRequest(JSON.parse(text), Buffer.byteLength(text, "utf8"));
    return requestEstimate(req.model, req.maxTokens, cap, null, undefined, { ...req.prompt, bytes: Buffer.byteLength(text, "utf8") });
  };
  // The two bodies the review found: a helper caller now gets the cap, as the proxy does.
  for (const body of [
    { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 10 },
    { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 0 },
  ]) {
    const text = JSON.stringify(body);
    const input = budgetInputForChatRequest(text);
    assert.ok(gate.estimate(input).usd >= cap, text);
    assert.deepEqual(gate.estimate(input), proxyHold(text), text);
  }
  // Same model, output limit, text-only flag and byte count as the proxy, over the seeded bodies.
  const r = makeRng(SEED ^ 0x4242);
  for (let i = 0; i < 5_000; i += 1) {
    const sent = randomBody(r);
    const text = serialize(r, sent);
    const body = JSON.parse(text);
    const input = budgetInputForChatRequest(text);
    const req = admissionRequest(body, 0);
    assert.equal(input.model, req.model, `case ${i}`);
    assert.equal(input.maxTokens, req.maxTokens, `case ${i}`);
    assert.equal(input.promptTextOnly, req.prompt.textOnly, `case ${i}`);
    assert.equal(input.promptBytes, Buffer.byteLength(text, "utf8"), `case ${i}`);
    assert.equal(input.maxTokens, chatOutputLimit(body), `case ${i}`);
  }
  // The check runs on the text that is sent, so an object's toJSON cannot show it another shape.
  const sneaky = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
  Object.defineProperty(sneaky, "toJSON", {
    enumerable: false,
    value: () => ({ model: "gpt-4o", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }),
  });
  assert.equal(isTextOnlyPrompt(sneaky), true);
  assert.equal(budgetInputForChatRequest(JSON.stringify(sneaky)).promptTextOnly, false);
  for (const bad of ["", "[]", "null", "{}", '{"model":""}', '{"model":5}', 5, undefined]) {
    assert.throws(() => budgetInputForChatRequest(bad), TypeError, String(bad));
  }
});

test("isTextOnlyPrompt: max_completion_tokens without a usable max_tokens is not text-only", () => {
  const base = { model: "gpt-4o", messages: [{ role: "user", content: "x" }] };
  assert.equal(isTextOnlyPrompt({ ...base, max_completion_tokens: 10 }), false);
  assert.equal(isTextOnlyPrompt({ ...base, max_tokens: 0, max_completion_tokens: 10 }), false);
  assert.equal(isTextOnlyPrompt({ ...base, max_tokens: 5, max_completion_tokens: 10 }), true);
  // A present limit that is not usable (0, negative, a string) ends the bound; null is absent.
  for (const bad of [0, -1, 0.5, "5", true, Infinity]) {
    assert.equal(isTextOnlyPrompt({ ...base, max_tokens: 5, max_completion_tokens: bad }), false, String(bad));
    assert.equal(isTextOnlyPrompt({ ...base, max_tokens: bad }), false, String(bad));
  }
  assert.equal(isTextOnlyPrompt({ ...base, max_tokens: 5, max_completion_tokens: null }), true);
  assert.equal(isTextOnlyPrompt({ ...base, max_tokens: null }), true);
  // chatOutputLimit: below 1 is absent; the larger field wins; n multiplies.
  assert.equal(chatOutputLimit({ ...base, max_tokens: 0 }), null);
  assert.equal(chatOutputLimit({ ...base, max_tokens: 0.9, max_completion_tokens: 7.8 }), 7);
  assert.equal(chatOutputLimit({ ...base, max_tokens: 3, n: 4 }), 12);
  assert.equal(chatOutputLimit(null), null);
});
