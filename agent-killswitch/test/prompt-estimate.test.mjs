// The pre-call estimate counts a bound on prompt tokens (one per request
// byte). These tests are offline: a stub upstream on 127.0.0.1:0, no key,
// no network, no spend.
//
// The differential tests compare this tree with test/gate-0.1.11.fixture.mjs,
// the compiled gate of the tree before the bound existed. Cases come from a
// fixed-seed generator (mulberry32), so a failure reproduces exactly.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createBudgetGate, isTextOnlyPrompt } from "@twzrd1111/agent-killswitch";
import { admissionRequest, createServer } from "../dist/index.js";
import { evaluateGate, requestEstimate } from "../dist/gate.js";
import { costUsd, priceFor } from "../dist/pricing.js";
import * as before from "./gate-0.1.11.fixture.mjs";

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

const MAX_TOKENS_VALUES = [0, 1, 16, 1_000, 8_000, 250_000, 12.7, -1, -1_000_000, "100", null, true];

function randomBody(r) {
  const body = { model: r.pick(MODELS) };
  const count = r.pick([0, 1, 2, r.int(0, 6)]);
  body.messages = Array.from({ length: count }, () => randomMessage(r));
  if (r.chance(0.7)) body.max_tokens = r.pick(MAX_TOKENS_VALUES);
  if (r.chance(0.2)) body.temperature = r.next();
  if (r.chance(0.1)) body.stream = r.chance(0.5);
  if (r.chance(0.05)) body.n = r.int(1, 4);
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

test(`differential, ${BODY_CASES} seeded request bodies: proxy and createBudgetGate agree, and neither is below 0.1.11`, (t) => {
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
    const usable = typeof m === "number" && Number.isFinite(m) && m >= 0;
    const apiRequest = {
      model: sent.model,
      maxTokens: usable ? Math.floor(m) : null,
      promptBytes: raw.length,
      promptTextOnly: isTextOnlyPrompt(body),
      zeroPriceModels,
    };
    const gate = createBudgetGate({ ...limits, modelRates });
    assert.deepEqual(gate.estimate(apiRequest), proxyEst, `estimate differs, ${label}`);
    assert.deepEqual(gate.evaluate({ ...apiRequest, window }), proxyDecision, `decision differs, ${label}`);

    // Against 0.1.11, with 0.1.11's own reading of max_tokens (any finite number, floored).
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
    { model: "gpt-4o", messages: [{ role: "assistant" }], n: 2, stop: ["x"], seed: 1, user: "u", request_id: "r" },
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
  const low = (1_000 * 10) / 1_000_000; // what 0.1.11 held: max_tokens only
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
  // A max_tokens that is not a finite non-negative number is treated as absent.
  for (const maxTokens of [Number.NaN, -1, -1e9, Infinity, "5"]) {
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
  const state = { hits: 0, usage: null };
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      state.hits += 1;
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
  const port2 = await startKillswitch();
  const r3 = await post(port2, raw);
  assert.equal(r3.status, 429);
  assert.equal(r3.json.error.code, "budget_exceeded");
  assert.match(r3.json.error.message, /Token-per-minute limit/);
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
      maxTokens: typeof m === "number" && Number.isFinite(m) && m >= 0 ? Math.floor(m) : null,
      promptBytes: raw.length,
      promptTextOnly: isTextOnlyPrompt(JSON.parse(raw.toString("utf8"))),
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
