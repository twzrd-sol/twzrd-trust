/**
 * Bind a paid response to the payment that bought it, and gate release on it.
 *
 * Nothing here fetches keys or settles anything: the caller supplies the
 * intent it approved, the settlement it observed, and the bytes it received.
 * `bindDelivery` checks the settlement against the intent, hashes the body,
 * and optionally checks a seller signature against caller-pinned keys.
 * `release` accepts only a verified delivery, at the type level and at
 * runtime, so an unverified response cannot flow downstream by accident.
 */
import crypto from "node:crypto";

const sha256Hex = (b: Uint8Array | string): string =>
  crypto.createHash("sha256").update(b).digest("hex");

/** What the buyer approved before signing. Amounts are integer atomic strings. */
export interface DeliveryIntent {
  method: string;
  url: string;
  /** SHA-256 hex of the exact request bytes that were sent. */
  bodyHash: string;
  payTo: string;
  amountAtomic: string;
  network: string;
  asset: string;
  model?: string;
}

/** What the buyer observed after paying: the settlement receipt. */
export interface DeliverySettlement {
  /** On-chain transaction that moved the money, hex with 0x. */
  tx: string;
  amountAtomic: string;
  payee: string;
  asset: string;
  network: string;
}

/** An optional seller signature over (intent_hash, response_hash). */
export interface SellerSignature {
  kid: string;
  /** Hex signature over the ASCII bytes `${intentHash}.${responseHash}`. */
  signatureHex: string;
  /** Pinned Ed25519 public key, 32 raw bytes. Never fetched. */
  publicKey: Uint8Array;
}

export type DeliveryCode =
  | "settlement_mismatch"
  | "seller_sig_invalid"
  | "seller_sig_required";

export interface VerifiedDelivery {
  readonly verified: true;
  /** SHA-256 hex of the canonical intent; the dedupe-safe purchase id. */
  readonly intentHash: string;
  readonly responseHash: string;
  readonly settlementRef: string;
  readonly sellerSigned: boolean;
}

export interface UnverifiedDelivery {
  readonly verified: false;
  readonly code: DeliveryCode;
  readonly detail: string;
}

const isHex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

function canonicalIntent(intent: DeliveryIntent): string {
  return JSON.stringify({
    method: intent.method,
    url: intent.url,
    bodyHash: intent.bodyHash,
    payTo: intent.payTo,
    amountAtomic: intent.amountAtomic,
    network: intent.network,
    asset: intent.asset,
    model: intent.model ?? null,
  });
}

/**
 * Bind a response to its payment. Returns Verified only when the settlement
 * names the intent's payee, asset, network and amount, and records the
 * response hash. A seller signature is checked when supplied; when
 * `requireSigned` is set, an unsigned delivery is refused instead of
 * returned unsigned.
 */
export function bindDelivery(input: {
  intent: DeliveryIntent;
  settlement: DeliverySettlement;
  /** The exact bytes received, before any parsing. */
  body: Uint8Array;
  sellerSig?: SellerSignature | null;
  requireSigned?: boolean;
}): VerifiedDelivery | UnverifiedDelivery {
  const { intent, settlement, body } = input;
  const no = (code: DeliveryCode, detail: string): UnverifiedDelivery => ({ verified: false, code, detail });
  if (!isHex64(intent.bodyHash)) return no("settlement_mismatch", "intent.bodyHash is not a sha256 hex");
  if (typeof settlement.tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(settlement.tx)) {
    return no("settlement_mismatch", "settlement.tx is not a transaction hash");
  }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (
    !same(settlement.payee, intent.payTo) ||
    String(settlement.amountAtomic) !== String(intent.amountAtomic) ||
    !same(settlement.asset, intent.asset) ||
    settlement.network !== intent.network
  ) {
    return no("settlement_mismatch", "settlement does not name the intent's payee, amount, asset and network");
  }
  const intentHash = sha256Hex(canonicalIntent(intent));
  const responseHash = sha256Hex(body);
  const sig = input.sellerSig ?? null;
  if (sig !== null) {
    if (typeof sig.kid !== "string" || sig.kid.length === 0 || !(sig.publicKey instanceof Uint8Array) || sig.publicKey.length !== 32) {
      return no("seller_sig_invalid", "seller signature is malformed");
    }
    let sigBytes: Buffer;
    try {
      sigBytes = Buffer.from(sig.signatureHex, "hex");
    } catch {
      return no("seller_sig_invalid", "seller signature is not hex");
    }
    if (sigBytes.length !== 64) return no("seller_sig_invalid", "seller signature is not 64 bytes");
    const ok = crypto.verify(
      null,
      Buffer.from(`${intentHash}.${responseHash}`, "utf8"),
      { key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(sig.publicKey)]), format: "der", type: "spki" },
      sigBytes,
    );
    if (!ok) return no("seller_sig_invalid", `seller signature does not verify under kid ${sig.kid}`);
    return { verified: true, intentHash, responseHash, settlementRef: settlement.tx, sellerSigned: true };
  }
  if (input.requireSigned === true) return no("seller_sig_required", "no seller signature was supplied");
  return { verified: true, intentHash, responseHash, settlementRef: settlement.tx, sellerSigned: false };
}

/**
 * Release a delivery downstream. Accepts only a verified delivery: passing
 * anything else throws, so an unverified response cannot flow into a
 * pipeline, a deliverable, or the next paid step by accident.
 */
export function release(delivery: VerifiedDelivery | UnverifiedDelivery): VerifiedDelivery {
  if (delivery === null || typeof delivery !== "object" || delivery.verified !== true) {
    const code = delivery !== null && typeof delivery === "object" && "code" in delivery
      ? String((delivery as UnverifiedDelivery).code)
      : "not_verified";
    throw new TypeError(`cannot release an unverified delivery (${code})`);
  }
  return delivery;
}
