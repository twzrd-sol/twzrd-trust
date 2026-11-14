/**
 * Strict base64 for payment headers, payment payloads and signatures.
 *
 * `Buffer.from(text, "base64")` never refuses: it reads the URL-safe alphabet
 * as well as the standard one, skips whitespace and other characters outside
 * the alphabet, accepts missing padding, and stops at the first `=` without
 * looking at what follows. Two different header values then decode to the
 * same payment, and a value another decoder would refuse (the x402 client
 * uses `atob`) still reads here.
 *
 * This reader accepts RFC 4648 section 4 base64 in its canonical form only:
 *   - the standard alphabet (`A-Z a-z 0-9 + /`); `-` and `_` are refused
 *   - a length that is a multiple of four, padded with `=` or `==` where the
 *     last group is short, and no `=` anywhere else
 *   - no whitespace and no other character
 *   - zero in the unused low bits of the last symbol (RFC 4648 section 3.5),
 *     so each byte string has exactly one accepted text
 *
 * Everything else is unreadable. Callers treat unreadable the way they
 * treated a header that was not JSON: the payment is not compared, not
 * stamped, or refused, as each call site already did.
 */

const CANONICAL_SHAPE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The bytes `text` encodes, or null when `text` is not canonical standard base64. */
export function decodeBase64Strict(text: unknown): Buffer | null {
  if (typeof text !== "string" || !CANONICAL_SHAPE.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  return bytes.toString("base64") === text ? bytes : null;
}

/** Whether `text` is canonical standard base64 (the empty string is). */
export function isStrictBase64(text: unknown): text is string {
  return decodeBase64Strict(text) !== null;
}

/**
 * The UTF-8 text `text` encodes. Throws when `text` is not canonical standard
 * base64, so a `JSON.parse(base64ToUtf8Strict(header))` inside a try block
 * fails the same way a non-JSON header does.
 */
export function base64ToUtf8Strict(text: unknown): string {
  const bytes = decodeBase64Strict(text);
  if (bytes === null) throw new TypeError("not canonical RFC 4648 base64");
  return bytes.toString("utf8");
}
