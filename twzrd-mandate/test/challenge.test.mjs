// Reading a 402: strict decoding, pricing one offer, and narrowing a
// challenge to the single approved offer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BASE_USDC,
  LEDGER_GENESIS,
  LOOPBACK_BASE_SELLER,
  LOOPBACK_SELLER,
  MAX_OFFERS,
  SOLANA_USDC,
  lineHash,
  narrowChallenge,
  openDecisionLedger,
  readChallenge,
  readOffer,
  sameOffer,
  strictBase64ToUtf8,
  verifyDecisionLedger,
} from "../dist/index.js";
import { tempDir } from "./helpers.mjs";

const b64 = (doc) => Buffer.from(typeof doc === "string" ? doc : JSON.stringify(doc), "utf8").toString("base64");
const bytes = (doc) => new TextEncoder().encode(typeof doc === "string" ? doc : JSON.stringify(doc));
const offer = (extra = {}) => ({ scheme: "exact", network: "solana", payTo: LOOPBACK_SELLER, asset: SOLANA_USDC, maxAmountRequired: "10000", ...extra });

test("strict base64: only the canonical encoding of valid UTF-8 decodes", () => {
  assert.equal(strictBase64ToUtf8(b64("hello")), "hello");
  assert.equal(strictBase64ToUtf8(b64({ a: 1 })), '{"a":1}');
  const canonical = b64("ab"); // "YWI="
  for (const bad of [
    "",
    canonical.replace("=", ""), // padding dropped
    `${canonical}=`,
    ` ${canonical}`,
    `${canonical}\n`,
    canonical.replace("YWI", "YW-"), // url-safe alphabet
    "YWJ=", // non-zero trailing bits: decodes to "ab" loosely, but is not canonical
    "!!!!",
    Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"), // not UTF-8
  ]) {
    assert.equal(strictBase64ToUtf8(bad), null, JSON.stringify(bad));
  }
});

test("a challenge is read from the header first, then from a JSON body", () => {
  const doc = { x402Version: 2, accepts: [offer()] };
  const header = readChallenge(new Headers({ "payment-required": b64(doc) }), bytes("ignored"));
  assert.deepEqual([header.ok, header.challenge.via, header.challenge.accepts.length], [true, "header", 1]);
  const body = readChallenge(new Headers(), bytes({ x402Version: 1, accepts: [offer()] }));
  assert.deepEqual([body.ok, body.challenge.via], [true, "body"]);
  // A header that is present and unreadable is not skipped in favour of the body.
  const both = readChallenge(new Headers({ "payment-required": "not base64!" }), bytes(doc));
  assert.deepEqual([both.ok, both.code], [false, "payment_required_unreadable"]);
});

test("unreadable challenges are refused, with MPP named for what it is", () => {
  const cases = [
    [new Headers(), bytes("payment required")],
    [new Headers(), bytes({})],
    [new Headers(), bytes({ accepts: [] })],
    [new Headers(), bytes({ accepts: "all" })],
    [new Headers(), bytes({ accepts: [1, 2] })],
    [new Headers(), bytes({ accepts: Array.from({ length: MAX_OFFERS + 1 }, () => offer()) })],
    [new Headers(), new Uint8Array([0xff, 0xfe])],
    [new Headers({ "payment-required": b64("not json") }), bytes("")],
    [new Headers({ "payment-required": b64([1]) }), bytes("")],
    [new Headers({ "payment-required": b64({ accepts: [offer()] }).replace(/=+$/, "") + "A" }), bytes("")],
  ];
  for (const [headers, body] of cases) {
    const read = readChallenge(headers, body);
    assert.deepEqual([read.ok, read.code], [false, "payment_required_unreadable"], new TextDecoder().decode(body));
  }
  const mpp = readChallenge(new Headers({ "www-authenticate": 'Payment id="x", method="tempo", intent="charge"' }), bytes(""));
  assert.equal(mpp.ok, false);
  assert.match(mpp.detail, /MPP/);
  assert.equal(readChallenge(new Headers(), bytes({ accepts: Array.from({ length: MAX_OFFERS }, () => offer()) })).ok, true);
});

test("an offer has a price only when it is exact-amount USDC on Solana or Base mainnet", () => {
  const ok = readOffer(offer());
  assert.deepEqual([ok.ok, ok.offer.amountMicro, ok.offer.chain, ok.offer.payTo], [true, 10_000n, "solana", LOOPBACK_SELLER]);
  const base = readOffer(offer({ network: "base", payTo: LOOPBACK_BASE_SELLER, asset: BASE_USDC }));
  assert.deepEqual([base.ok, base.offer.chain, base.offer.caip2], [true, "base", "eip155:8453"]);
  const caip = readOffer(offer({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }));
  assert.deepEqual([caip.ok, caip.offer.chain], [true, "solana"]);
  const v2 = readOffer({ scheme: "exact", network: "solana", payTo: LOOPBACK_SELLER, asset: SOLANA_USDC, amount: "250" });
  assert.deepEqual([v2.ok, v2.offer.amountMicro], [true, 250n]);

  // A whole number written as a JSON number is the same amount.
  const numeric = readOffer(offer({ maxAmountRequired: 10000 }));
  assert.deepEqual([numeric.ok, numeric.offer.amountMicro], [true, 10_000n]);

  const refused = [
    [{ payTo: undefined }, "payment_required_unreadable"],
    [{ payTo: "" }, "payment_required_unreadable"],
    [{ payTo: "0x1111111111111111111111111111111111111111" }, "payment_required_unreadable"], // an EVM address on Solana
    [{ maxAmountRequired: undefined }, "payment_required_unreadable"],
    [{ maxAmountRequired: 10000.5 }, "payment_required_unreadable"],
    [{ maxAmountRequired: "1e4" }, "payment_required_unreadable"],
    [{ maxAmountRequired: "-1" }, "payment_required_unreadable"],
    [{ maxAmountRequired: "0.01" }, "payment_required_unreadable"],
    [{ maxAmountRequired: "010" }, "payment_required_unreadable"],
    [{ maxAmountRequired: "9".repeat(19) }, "payment_required_unreadable"],
    [{ maxAmountRequired: "0" }, "unpriced_offer"],
    [{ network: undefined }, "payment_required_unreadable"],
    [{ network: "solana-devnet" }, "chain_not_allowed"],
    [{ network: "ethereum" }, "chain_not_allowed"],
    [{ network: "eip155:1" }, "chain_not_allowed"],
    [{ network: "tempo" }, "chain_not_allowed"],
    [{ asset: "So11111111111111111111111111111111111111112" }, "unpriced_offer"],
    [{ asset: undefined }, "unpriced_offer"],
    [{ asset: BASE_USDC }, "unpriced_offer"], // Base USDC named on Solana
    [{ scheme: "upto" }, "payment_required_unreadable"],
  ];
  for (const [extra, code] of refused) {
    const read = readOffer(offer(extra));
    assert.equal(read.ok, false, JSON.stringify(extra));
    assert.equal(read.code, code, `${JSON.stringify(extra)}: ${read.detail}`);
  }
  // Two amount fields that disagree are a conflict, not a choice.
  const conflict = readOffer(offer({ amount: "1" }));
  assert.equal(conflict.ok, false, "an offer with two different amounts was priced");
});

test("the approved offer may come back cheaper, never dearer, never to someone else", () => {
  const approved = readOffer(offer()).offer;
  const again = (extra) => readOffer(offer(extra)).offer;
  assert.equal(sameOffer(approved, again({})), true);
  assert.equal(sameOffer(approved, again({ maxAmountRequired: "9999" })), true);
  assert.equal(sameOffer(approved, again({ maxAmountRequired: "10001" })), false);
  assert.equal(sameOffer(approved, again({ payTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" })), false);
  assert.equal(sameOffer(approved, readOffer(offer({ network: "base", payTo: LOOPBACK_BASE_SELLER, asset: BASE_USDC })).offer), false);
});

test("a narrowed challenge carries exactly the one offer, where the original carried its offers", async () => {
  const wash = offer({ payTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", maxAmountRequired: "900000" });
  const doc = { x402Version: 2, error: "pay", accepts: [wash, offer()] };
  const viaBody = readChallenge(new Headers(), bytes(doc)).challenge;
  const narrowedBody = narrowChallenge(new Response(JSON.stringify(doc), { status: 402, headers: { "content-length": "999", "x-keep": "1" } }), viaBody, offer());
  assert.equal(narrowedBody.status, 402);
  assert.equal(narrowedBody.headers.get("x-keep"), "1");
  assert.equal(narrowedBody.headers.get("content-length"), null);
  const bodyDoc = await narrowedBody.json();
  assert.deepEqual([bodyDoc.x402Version, bodyDoc.accepts.length, bodyDoc.accepts[0].payTo], [2, 1, LOOPBACK_SELLER]);

  const viaHeader = readChallenge(new Headers({ "payment-required": b64(doc) }), bytes("")).challenge;
  const narrowedHeader = narrowChallenge(new Response(null, { status: 402, headers: { "payment-required": b64(doc) } }), viaHeader, offer());
  const headerDoc = JSON.parse(strictBase64ToUtf8(narrowedHeader.headers.get("payment-required")));
  assert.deepEqual([headerDoc.accepts.length, headerDoc.accepts[0].payTo], [1, LOOPBACK_SELLER]);
  assert.equal(JSON.stringify(headerDoc).includes("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"), false);
});

test("the decision ledger chains every line to the one before it", () => {
  const dir = tempDir();
  const file = path.join(dir, "ledger.jsonl");
  let now = Date.parse("2026-11-17T08:00:00Z");
  const ledger = openDecisionLedger(file, "mnd_test", () => now);
  assert.deepEqual([ledger.count(), ledger.head()], [0, LEDGER_GENESIS]);
  const row = (code) => ({ tool: "http:x", target: "http://x/", outcome: "refused", layer: 3, code, detail: "d", requestId: "r", quotedUsd: null, settledUsd: null, signatures: 0, payTo: null, receipt: null, inclusion: null });
  const first = ledger.append(row("a"));
  now += 1000;
  const second = ledger.append(row("b"));
  assert.deepEqual([first.seq, first.prev, second.seq], [1, LEDGER_GENESIS, 2]);
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  assert.equal(second.prev, lineHash(lines[0]));
  assert.equal(ledger.head(), lineHash(lines[1]));
  assert.deepEqual(verifyDecisionLedger(file), { ok: true, lines: 2, head: ledger.head(), breaks: [], tornTail: false });
  assert.deepEqual(ledger.tail(1).map((r) => r.code), ["b"]);

  // Reopening continues the chain. A renewed mandate keeps the state directory, and each line names its mandate.
  const reopened = openDecisionLedger(file, "mnd_renewed", () => now);
  const third = reopened.append(row("c"));
  assert.deepEqual([third.seq, third.mandateId, third.prev], [3, "mnd_renewed", lineHash(lines[1])]);

  // Deleting, reordering or editing a line breaks the chain.
  const good = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  for (const mutate of [(l) => [l[0], l[2]], (l) => [l[1], l[0], l[2]], (l) => [l[0], l[1].replace('"b"', '"z"'), l[2]], (l) => [l[1], l[2]]]) {
    fs.writeFileSync(file, `${mutate(good).join("\n")}\n`);
    assert.equal(verifyDecisionLedger(file).ok, false);
  }
  // Dropping the last line cannot be told from a shorter ledger by the file alone; the heartbeat's ledgerHeadHash is what pins the head.
  fs.writeFileSync(file, `${good.slice(0, 2).join("\n")}\n`);
  assert.equal(verifyDecisionLedger(file).ok, true);
  assert.equal(verifyDecisionLedger(path.join(dir, "absent.jsonl")).lines, 0);
});
