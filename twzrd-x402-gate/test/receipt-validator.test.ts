import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { sha256Hex, signReceipt, splitSseReceipt, sseTrailer, verifyReceipt } from "outbid-receipt-verify";
import type { ApprovalBinding } from "../src/outcome-ledger.js";
import { OUTBID_RECEIPT_RULE_V1, receiptValidationRule } from "../src/receipt-validator.js";

const ISS = "https://seller.example";
const PAYER = "0x00000000000000000000000000000000000000b2";
const PAYEE = "0x00000000000000000000000000000000000000a1";
const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TX = "0x" + "cd".repeat(32);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = [{ kid: "k1", kty: "OKP", crv: "Ed25519", x: publicKey.export({ format: "jwk" }).x }];
const enc = (s: string) => new TextEncoder().encode(s);
const requestBody = enc(JSON.stringify({ model: "paid/m", messages: [] }));
const approval = {
  payTo: PAYEE, network: "eip155:8453", asset: ASSET, amountAtomic: "1000", maxAllInAtomic: "1000",
  request: { method: "POST", url: "https://seller.example/v1/chat/completions", bodyHash: sha256Hex(requestBody), queryHash: "" },
  expiresAt: new Date(Date.now() + 60_000).toISOString(), validation: { ruleVersion: OUTBID_RECEIPT_RULE_V1 },
} as unknown as ApprovalBinding;
const tokenFor = (body: Uint8Array, over: Record<string, unknown> = {}) => signReceipt({
  iss: ISS, kid: "k1", issued_at: Math.floor(Date.now() / 1000),
  request: { method: "POST", path: "/v1/chat/completions", sha256: sha256Hex(requestBody) },
  network: "eip155:8453", payer: PAYER, payee: PAYEE, asset: ASSET, amount_atomic: "1000",
  settlement_ref: TX, resolved_model: "paid/m", body_sha256: sha256Hex(body), ...over,
}, privateKey).token;
const rule = (extra: Partial<Parameters<typeof receiptValidationRule>[0]> = {}) =>
  receiptValidationRule({ verify: verifyReceipt, keys, iss: ISS, payer: PAYER, splitSse: splitSseReceipt, ...extra });
const ctx = (response: Response, over: Record<string, unknown> = {}) => ({ response, intentHash: "h", approval, settlementTx: TX, requestBody, ...over });
const codes = async (p: ReturnType<ReturnType<typeof rule>["validate"]>) => { const v = await p; return [v.ok, ...(v.reasonCodes ?? [])]; };

test("a JSON response with a valid header receipt passes with receipt_verified under the rule version", async () => {
  const body = enc('{"ok":true}');
  const { validate, ruleVersion } = rule();
  assert.equal(ruleVersion, OUTBID_RECEIPT_RULE_V1);
  const v = await validate(ctx(new Response(body, { headers: { "Outbid-Receipt": tokenFor(body) } })));
  assert.deepEqual(v, { ok: true, ruleVersion: OUTBID_RECEIPT_RULE_V1, reasonCodes: ["receipt_verified"] });
  // The alias header is read too.
  assert.deepEqual(await codes(validate(ctx(new Response(body, { headers: { "X-Outbid-Receipt": tokenFor(body) } })))), [true, "receipt_verified"]);
});

test("each binding the receipt carries is checked: payer, settlement, model, age", async () => {
  const body = enc('{"ok":true}');
  const res = (t: string) => new Response(body, { headers: { "Outbid-Receipt": t } });
  assert.deepEqual(await codes(rule().validate(ctx(res(tokenFor(body, { payer: "0x" + "99".repeat(20) }))))), [false, "receipt_mismatch:payer"]);
  assert.deepEqual(await codes(rule().validate(ctx(res(tokenFor(body)), { settlementTx: "0x" + "11".repeat(32) }))), [false, "receipt_mismatch:settlement_ref"]);
  assert.deepEqual(await codes(rule({ model: () => "paid/other" }).validate(ctx(res(tokenFor(body))))), [false, "receipt_mismatch:resolved_model"]);
  assert.deepEqual(await codes(rule({ now: () => Date.now() + 3_600_000 }).validate(ctx(res(tokenFor(body))))), [false, "receipt_too_old"]);
  assert.deepEqual(await codes(rule({ iss: "https://other.example" }).validate(ctx(res(tokenFor(body))))), [false, "receipt_mismatch:iss"]);
});

test("what it cannot check is a failure, never a pass", async () => {
  const body = enc('{"ok":true}');
  const res = () => new Response(body, { headers: { "Outbid-Receipt": tokenFor(body) } });
  assert.deepEqual(await codes(rule().validate(ctx(new Response(body)))), [false, "receipt_missing"]);
  assert.deepEqual(await codes(rule().validate(ctx(res(), { settlementTx: undefined }))), [false, "receipt_unverifiable:no_settlement_tx"]);
  assert.deepEqual(await codes(rule().validate(ctx(res(), { requestBody: undefined }))), [false, "receipt_unverifiable:no_request_body"]);
  assert.deepEqual(await codes(rule().validate(ctx(res(), { requestBody: enc("not json") }))), [false, "receipt_unverifiable:no_model"]);
  assert.deepEqual(await codes(rule({ verify: () => { throw new Error("boom"); } }).validate(ctx(res()))), [false, "receipt_verifier_threw"]);
});

test("a stream: the receipt in the SSE trailer covers every byte before it", async () => {
  const body = enc('data: {"delta":"hi"}\n\ndata: [DONE]\n\n');
  const stream = (b: Uint8Array, t: string) => new Response(new Uint8Array([...b, ...enc(sseTrailer(b, t))]), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  assert.deepEqual(await codes(rule().validate(ctx(stream(body, tokenFor(body))))), [true, "receipt_verified"]);
  const other = enc('data: {"delta":"ho"}\n\ndata: [DONE]\n\n');
  assert.deepEqual(await codes(rule().validate(ctx(stream(other, tokenFor(body))))), [false, "receipt_mismatch:body_sha256"]);
  assert.deepEqual(await codes(rule().validate(ctx(new Response(body, { headers: { "content-type": "text/event-stream" } })))), [false, "receipt_no_receipt"]);
  assert.deepEqual(await codes(rule({ splitSse: undefined }).validate(ctx(stream(body, tokenFor(body))))), [false, "receipt_missing"], "no splitter: a trailer is not read");
});
