/**
 * Payment headers, payment payloads and signatures are read as canonical
 * RFC 4648 standard base64 or not at all.
 *
 * Node's `Buffer.from(text, "base64")` reads the URL-safe alphabet, skips
 * whitespace and other characters, accepts missing padding and stops at the
 * first `=`. These tests hold the decoder that replaced it, and each place the
 * gate decodes: a value in any other spelling is unreadable there, with the
 * outcome that call site already had for a value that is not JSON.
 *
 * Run: npx tsx --test test/strict-base64.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { ATTEMPT_EXTENSION, stampPaymentSignatureHeader } from "../src/attempt-echo.js";
import { buildFulfillmentRecord } from "../src/fulfillment-record.js";
import {
  approvedRequirementOf,
  PAYMENT_PAYLOAD_UNREADABLE,
  paymentBindingRefusal,
} from "../src/payment-binding.js";
import { paymentRequiredFromResponse } from "../src/payto.js";
import { base64ToUtf8Strict, decodeBase64Strict, isStrictBase64 } from "../src/strict-base64.js";

const b64 = (s: string | Uint8Array) => Buffer.from(s as string, typeof s === "string" ? "utf8" : undefined).toString("base64");

const REQ = {
  scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "1000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: "SeLLeRWa11et1111111111111111111111111111111", maxTimeoutSeconds: 60,
};
// The resource URL puts a '/' and a '+' in the standard encoding, so the URL-safe spelling differs.
const PAYMENT = JSON.stringify({
  x402Version: 2, resource: { url: "https://example.com/report?id=10>>>???" }, accepted: REQ, payload: { transaction: "AQ==" },
});
const STANDARD = b64(PAYMENT);

/** Other spellings Node's decoder reads as the same bytes. */
function respellings(standard: string): Record<string, string> {
  const out: Record<string, string> = {
    "trailing newline": `${standard}\n`,
    "leading space": ` ${standard}`,
    "a space inside": `${standard.slice(0, 8)} ${standard.slice(8)}`,
    "a line break inside (MIME style)": `${standard.slice(0, 76)}\r\n${standard.slice(76)}`,
    "a character outside the alphabet inside": `${standard.slice(0, 8)}!${standard.slice(8)}`,
    "one '=' too many": `${standard}=`,
    "text after the padding": `${standard}${standard.endsWith("=") ? "" : "="}AAAA`,
  };
  if (/[+/]/.test(standard)) {
    out["URL-safe alphabet"] = standard.replace(/\+/g, "-").replace(/\//g, "_");
    out["URL-safe alphabet, no padding"] = Buffer.from(standard, "base64").toString("base64url");
  }
  if (standard.endsWith("=")) {
    out["padding removed"] = standard.replace(/=+$/, "");
    // The last symbol before the padding carries unused low bits: set one.
    const i = standard.indexOf("=") - 1;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    out["non-zero unused bits in the last symbol"] =
      standard.slice(0, i) + alphabet[alphabet.indexOf(standard[i]) + 1] + standard.slice(i + 1);
  }
  return out;
}

test("the fixture payment exercises every respelling", () => {
  assert.match(STANDARD, /\+/);
  assert.match(STANDARD, /\//);
  assert.match(STANDARD, /=$/);
  const all = respellings(STANDARD);
  assert.equal(Object.keys(all).length, 11);
  for (const [name, text] of Object.entries(all)) {
    assert.notEqual(text, STANDARD, name);
    // Why this matters: Node's decoder reads the same payment out of every one of them.
    assert.equal(Buffer.from(text, "base64").toString("utf8"), PAYMENT, `${name}: Node reads something else`);
  }
});

test("decodeBase64Strict accepts canonical standard base64 and nothing else", () => {
  assert.equal(decodeBase64Strict(STANDARD)?.toString("utf8"), PAYMENT);
  assert.equal(base64ToUtf8Strict(STANDARD), PAYMENT);
  assert.equal(isStrictBase64(STANDARD), true);
  for (const [name, text] of Object.entries(respellings(STANDARD))) {
    assert.equal(decodeBase64Strict(text), null, name);
    assert.equal(isStrictBase64(text), false, name);
    assert.throws(() => base64ToUtf8Strict(text), TypeError, name);
  }

  const accepted: Array<[string, number[]]> = [
    ["", []], ["AA==", [0]], ["AAA=", [0, 0]], ["AAAA", [0, 0, 0]], ["/w==", [255]], ["+/+/", [251, 255, 191]],
    ["Zm9vYg==", [102, 111, 111, 98]], ["Zm9vYmE=", [102, 111, 111, 98, 97]],
  ];
  for (const [text, bytes] of accepted) {
    assert.deepEqual([...(decodeBase64Strict(text) ?? [-1])], bytes, JSON.stringify(text));
  }
  const refused: unknown[] = [
    "A", "AA", "AAA", "A===", "AA=", "AAA==", "=", "==", "====", "AA==AA==", "AAAA=", "AAAA==", "=AAA", "A=AA", "AA=A",
    "AB==", "AAB=", "_w==", "-A==", "AA\n==", "AAAA\n", "\nAAAA", "AAAA ", "\tAAAA", "AAAA\u0000", "AAAÀ", "AAA ",
    "data:;base64,AAAA", "AAAA,AAAA", "AAAA.AAAA",
    null, undefined, 0, 4, true, {}, [], ["AAAA"], Buffer.from("AAAA"), new String("AAAA"),
  ];
  for (const text of refused) {
    assert.equal(decodeBase64Strict(text), null, JSON.stringify(text));
  }
});

test("every byte string has exactly one accepted text", () => {
  // Deterministic bytes: lengths 0..96 cover each padding case many times.
  for (let n = 0; n < 97; n++) {
    const bytes = createHash("sha512").update(`strict-base64 ${n}`).digest().subarray(0, n % 65);
    const text = bytes.toString("base64");
    assert.deepEqual(decodeBase64Strict(text), bytes, `length ${bytes.length}`);
    for (const [name, other] of Object.entries(respellings(text))) {
      if (other === text) continue;
      assert.equal(decodeBase64Strict(other), null, `length ${bytes.length}: ${name}`);
    }
  }
  // Exhaustive for two symbols before '==': 4096 texts, 256 byte values, one text each.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const seen = new Map<number, string>();
  for (const a of alphabet) {
    for (const b of alphabet) {
      const got = decodeBase64Strict(`${a}${b}==`);
      if (!got) continue;
      assert.equal(got.length, 1);
      assert.equal(seen.has(got[0]), false, `${a}${b}== and ${seen.get(got[0])} both decode to ${got[0]}`);
      seen.set(got[0], `${a}${b}==`);
    }
  }
  assert.equal(seen.size, 256);
});

test("payment binding: the approved payment passes in standard base64 and is unreadable in any other spelling", () => {
  const approved = approvedRequirementOf(REQ);
  assert.equal(paymentBindingRefusal(approved, STANDARD), undefined);
  for (const [name, header] of Object.entries(respellings(STANDARD))) {
    assert.equal(paymentBindingRefusal(approved, header), PAYMENT_PAYLOAD_UNREADABLE, name);
  }
});

test("PAYMENT-REQUIRED: a challenge is read in standard base64 and blocked in any other spelling", async () => {
  const challenge = JSON.stringify({
    x402Version: 2, resource: { url: "https://example.com/report?id=10>>>???" }, accepts: [REQ],
  });
  const standard = b64(challenge);
  const respond = (value: string) => new Response("", { status: 402, headers: { "PAYMENT-REQUIRED": value } });
  assert.deepEqual(await paymentRequiredFromResponse(respond(standard)), JSON.parse(challenge));
  let tried = 0;
  for (const [name, value] of Object.entries(respellings(standard))) {
    let response: Response;
    try {
      response = respond(value);
    } catch {
      continue; // fetch's Headers refuses the value (a line break): it never reaches the gate
    }
    // Headers trims leading and trailing whitespace before any gate code sees the value.
    if (response.headers.get("PAYMENT-REQUIRED") === standard) continue;
    tried += 1;
    await assert.rejects(
      paymentRequiredFromResponse(response),
      /^Error: \[twzrd\] payment blocked: undecodable PAYMENT-REQUIRED header$/,
      name,
    );
  }
  assert.ok(tried >= 7, `only ${tried} respellings reached the gate`);
});

test("attempt echo: a payment header that is not standard base64 is passed on untouched, never re-encoded", () => {
  const challenge = { extensions: { [ATTEMPT_EXTENSION]: { attempt_key: "attempt-1" } } };
  const stamped = stampPaymentSignatureHeader(STANDARD, challenge);
  assert.notEqual(stamped, STANDARD);
  const read = JSON.parse(base64ToUtf8Strict(stamped)) as { extensions: Record<string, { attempt_key: string }> };
  assert.equal(read.extensions[ATTEMPT_EXTENSION].attempt_key, "attempt-1");
  for (const [name, header] of Object.entries(respellings(STANDARD))) {
    assert.equal(stampPaymentSignatureHeader(header, challenge), header, name);
  }
});

test("fulfillment record: terms and settlement are read from standard base64 only", () => {
  const settle = b64(JSON.stringify({ success: false, transaction: "5tx", network: "solana", note: ">>>???" }));
  const read = buildFulfillmentRecord({ httpStatus: 200, paymentHeader: STANDARD, paymentResponseHeader: settle, atUnixMs: 1 });
  assert.equal(read.paid_to, REQ.payTo);
  assert.equal(read.amount_atomic, "1000");
  assert.equal(read.settled, false);
  assert.equal(read.tx, "5tx");
  for (const [name, header] of Object.entries(respellings(STANDARD))) {
    const r = buildFulfillmentRecord({ httpStatus: 200, paymentHeader: header, paymentResponseHeader: settle, atUnixMs: 1 });
    assert.equal(r.paid_to, null, name);
    assert.equal(r.amount_atomic, null, name);
    assert.equal(r.settled, false, `${name}: the response header is still standard`);
  }
  for (const [name, header] of Object.entries(respellings(settle))) {
    const r = buildFulfillmentRecord({ httpStatus: 200, paymentHeader: STANDARD, paymentResponseHeader: header, atUnixMs: 1 });
    assert.equal(r.settled, null, name);
    assert.equal(r.tx, null, name);
    assert.equal(r.paid_to, REQ.payTo, name);
  }
});

test("no decode in src goes around the strict reader", () => {
  const dir = new URL("../src/", import.meta.url);
  const lenient: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const lines = readFileSync(new URL(name, dir), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/Buffer\.from\([^)]*,\s*["']base64["']\s*\)|\batob\(/.test(line)) lenient.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(lenient.map((l) => l.replace(/:\d+$/, "")).sort(), [
    // The seeded decision signer's secret parser: operator key material, not a payment input.
    // It accepts base64 and base64url by design and checks the round trip itself.
    "decision-token.ts",
    // The strict reader: it decodes only after the shape check, and compares the round trip.
    "strict-base64.ts",
  ], lenient.join(", "));
});
