/**
 * A strict reader for x402 `402 Payment Required` challenges.
 *
 * The rule this file exists for: a 402 the runtime cannot read is refused,
 * never passed along. A payer library may decode text a strict reader will
 * not (the x402 client uses `atob`), so "we could not read it" must never
 * mean "we did not check it, go ahead".
 */
import { isUsdcRequirement, resolveRequirementFields, toCaip2Network } from "twzrd-x402-gate";
import type { MandateChain } from "./schema.js";

export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const BASE_MAINNET_CAIP2 = "eip155:8453";
/** More distinct payment options than this in one 402 is refused. */
export const MAX_OFFERS = 8;

export type ChallengeRefusalCode = "payment_required_unreadable" | "unpriced_offer" | "chain_not_allowed";

export interface X402Challenge {
  /** Where the challenge was carried. */
  via: "header" | "body";
  /** The decoded challenge document. */
  doc: Record<string, unknown>;
  accepts: Record<string, unknown>[];
}

export type ChallengeRead = { ok: true; challenge: X402Challenge } | { ok: false; code: "payment_required_unreadable"; detail: string };

export interface PricedOffer {
  payTo: string;
  amountMicro: bigint;
  /** The network string exactly as the seller wrote it. */
  network: string;
  caip2: string;
  chain: MandateChain;
  asset: string;
  raw: Record<string, unknown>;
}

export type OfferRead = { ok: true; offer: PricedOffer } | { ok: false; code: ChallengeRefusalCode; detail: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode canonical base64 to UTF-8 text; null when the text is not the canonical encoding of valid UTF-8. */
export function strictBase64ToUtf8(text: string): string | null {
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function unreadable(detail: string): { ok: false; code: "payment_required_unreadable"; detail: string } {
  return { ok: false, code: "payment_required_unreadable", detail };
}

function fromDocument(doc: unknown, via: "header" | "body"): ChallengeRead {
  if (!isObject(doc)) return unreadable(`the ${via} challenge is not a JSON object`);
  const accepts = doc.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return unreadable(`the ${via} challenge lists no payment options`);
  if (accepts.length > MAX_OFFERS) return unreadable(`the challenge lists more than ${MAX_OFFERS} payment options`);
  for (const entry of accepts) {
    if (!isObject(entry)) return unreadable("a payment option is not an object");
  }
  return { ok: true, challenge: { via, doc, accepts: accepts as Record<string, unknown>[] } };
}

/**
 * Read the challenge of a 402 response: the `PAYMENT-REQUIRED` header first
 * (x402 v2), then a JSON body (x402 v1). Anything else is unreadable,
 * including an MPP (`WWW-Authenticate: Payment`) challenge, which this
 * version does not settle.
 */
export function readChallenge(headers: Headers, body: Uint8Array): ChallengeRead {
  const header = headers.get("payment-required");
  if (header !== null) {
    const text = strictBase64ToUtf8(header.trim() === header ? header : "");
    if (text === null) return unreadable("the PAYMENT-REQUIRED header is not canonical base64");
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return unreadable("the PAYMENT-REQUIRED header is not JSON");
    }
    return fromDocument(doc, "header");
  }
  let doc: unknown;
  let parsed = false;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    parsed = true;
  } catch {
    parsed = false;
  }
  if (parsed && isObject(doc) && Array.isArray(doc.accepts)) return fromDocument(doc, "body");
  const wwwAuth = headers.get("www-authenticate") ?? "";
  if (/(^|,)\s*Payment(\s|$)/i.test(wwwAuth)) {
    return unreadable("this is an MPP (WWW-Authenticate: Payment) challenge; this version settles x402 only");
  }
  return unreadable("the 402 carries no x402 challenge this runtime can read");
}

/**
 * Price one payment option in USD. Only an exact-amount USDC offer on Solana
 * mainnet or Base mainnet has a price here; everything else is refused.
 */
export function readOffer(raw: Record<string, unknown>): OfferRead {
  const fields = resolveRequirementFields(raw);
  if (fields.conflict !== undefined) {
    return { ok: false, code: "payment_required_unreadable", detail: `payment option refused: ${fields.conflict}` };
  }
  if (typeof fields.payTo !== "string" || fields.payTo.length === 0) {
    return { ok: false, code: "payment_required_unreadable", detail: "a payment option names no recipient" };
  }
  if (typeof fields.amount !== "string" || !/^(0|[1-9][0-9]{0,17})$/.test(fields.amount)) {
    return { ok: false, code: "payment_required_unreadable", detail: "a payment option has no readable amount" };
  }
  if (raw.scheme !== undefined && raw.scheme !== "exact") {
    return { ok: false, code: "unpriced_offer", detail: `only exact-amount offers are payable (scheme "${String(raw.scheme)}")` };
  }
  if (typeof raw.network !== "string" || raw.network.length === 0) {
    return { ok: false, code: "payment_required_unreadable", detail: "a payment option names no network" };
  }
  let caip2: string;
  try {
    caip2 = toCaip2Network(raw.network);
  } catch {
    return { ok: false, code: "chain_not_allowed", detail: `network "${raw.network}" is not Solana mainnet or Base mainnet` };
  }
  const chain: MandateChain | null = caip2 === SOLANA_MAINNET_CAIP2 ? "solana" : caip2 === BASE_MAINNET_CAIP2 ? "base" : null;
  if (chain === null) {
    return { ok: false, code: "chain_not_allowed", detail: `network "${raw.network}" is not Solana mainnet or Base mainnet` };
  }
  const recipientShape = chain === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/;
  if (!recipientShape.test(fields.payTo)) {
    return { ok: false, code: "payment_required_unreadable", detail: "the recipient is not an address on the named network" };
  }
  if (typeof raw.asset !== "string" || !isUsdcRequirement(raw)) {
    return { ok: false, code: "unpriced_offer", detail: "the offer is not priced in USDC on its network" };
  }
  const amountMicro = BigInt(fields.amount);
  if (amountMicro <= 0n) {
    return { ok: false, code: "unpriced_offer", detail: "the offer asks for a zero amount" };
  }
  return {
    ok: true,
    offer: { payTo: fields.payTo, amountMicro, network: raw.network, caip2, chain, asset: raw.asset, raw },
  };
}

/** True when `candidate` is the approved offer again: same recipient, network and asset, at no more than the approved price. */
export function sameOffer(approved: PricedOffer, candidate: PricedOffer): boolean {
  return (
    candidate.payTo === approved.payTo &&
    candidate.caip2 === approved.caip2 &&
    // EVM addresses compare without case; a Solana mint is case-sensitive.
    (approved.chain === "base" ? candidate.asset.toLowerCase() === approved.asset.toLowerCase() : candidate.asset === approved.asset) &&
    candidate.amountMicro <= approved.amountMicro
  );
}

/**
 * Rebuild a 402 so it carries exactly one payment option, in the place the
 * original carried its options. The payer wrapped around the runtime then has
 * nothing else it could choose to sign.
 */
export function narrowChallenge(original: Response, challenge: X402Challenge, offer: Record<string, unknown>): Response {
  const doc = { ...challenge.doc, accepts: [offer] };
  const headers = new Headers(original.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const json = JSON.stringify(doc);
  if (challenge.via === "header") {
    headers.set("payment-required", Buffer.from(json, "utf8").toString("base64"));
    return new Response(json, { status: 402, statusText: original.statusText, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(json, { status: 402, statusText: original.statusText, headers });
}
