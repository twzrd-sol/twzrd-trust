/**
 * Funnel join-key pass-through for paying clients.
 *
 * Server 402s (PR #2819) emit `extensions.twzrd_attempt` on PAYMENT-REQUIRED.
 * `@x402/fetch` / `@x402/core` createPaymentPayload drops unknown extensions,
 * so every paid retry lands as a new singleton in `x402_funnel_events`.
 *
 * This module copies the challenge's `twzrd_attempt` onto the retry payload.
 * It never mints a key. No challenge key → no stamp.
 */

import { paymentRequiredFromResponse } from "./payto.js";

export const ATTEMPT_EXTENSION = "twzrd_attempt";
export const ATTEMPT_EXTENSION_SCHEMA = "twzrd.attempt.v1";

type Dict = Record<string, unknown>;

function asRecord(value: unknown): Dict | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : null;
}

function clipKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return key.length > 0 ? key : null;
}

/**
 * Read `extensions.twzrd_attempt` from a decoded PAYMENT-REQUIRED / 402 body.
 * Header-first callers should parse PAYMENT-REQUIRED before passing the object.
 * Returns null when the challenge did not carry a key — never invents one.
 */
export function twzrdAttemptFromChallenge(challenge: unknown): Dict | null {
  const root = asRecord(challenge);
  if (!root) return null;
  const ext = asRecord(root.extensions);
  if (!ext) return null;
  const att = asRecord(ext[ATTEMPT_EXTENSION]);
  if (!att) return null;
  const key = clipKey(att.attempt_key);
  if (!key) return null;
  return { ...att, attempt_key: key };
}

/**
 * Embed the challenge's `twzrd_attempt` on a payment payload. Idempotent:
 * an already-present non-empty `attempt_key` is left alone. Never mints.
 */
export function stampTwzrdAttemptOnPaymentPayload(
  challenge: unknown,
  payload: unknown,
): unknown {
  const echo = twzrdAttemptFromChallenge(challenge);
  if (!echo) return payload;
  const root = asRecord(payload);
  if (!root) return payload;
  const ext = asRecord(root.extensions) ?? {};
  const existing = asRecord(ext[ATTEMPT_EXTENSION]);
  if (existing && clipKey(existing.attempt_key)) return payload;
  return {
    ...root,
    extensions: {
      ...ext,
      [ATTEMPT_EXTENSION]: echo,
    },
  };
}

function decodeB64Json(header: string): unknown | null {
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Decode PAYMENT-SIGNATURE / X-PAYMENT, stamp `twzrd_attempt`, re-encode. */
export function stampPaymentSignatureHeader(
  header: string,
  challenge: unknown,
): string {
  const decoded = decodeB64Json(header);
  if (decoded == null) return header;
  const stamped = stampTwzrdAttemptOnPaymentPayload(challenge, decoded);
  if (stamped === decoded) return header;
  return Buffer.from(JSON.stringify(stamped), "utf8").toString("base64");
}

function requestMapKey(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): string {
  if (typeof input === "string") {
    return `${(init?.method ?? "GET").toString().toUpperCase()} ${input}`;
  }
  if (input instanceof URL) {
    return `${(init?.method ?? "GET").toString().toUpperCase()} ${input.href}`;
  }
  return `${input.method} ${input.url}`;
}

function paymentHeaderValue(headers: Headers): string | null {
  return headers.get("PAYMENT-SIGNATURE") || headers.get("X-PAYMENT") || null;
}

/**
 * Fetch wrapper: remember `twzrd_attempt` from a 402 (PAYMENT-REQUIRED header
 * first, JSON body fallback) and stamp it onto the retry's PAYMENT-SIGNATURE.
 *
 * Sits under `wrapFetchWithPayment` so the official adapter's retry is joined
 * even when createPaymentPayload itself drops extensions.
 */
export function wrapFetchEchoTwzrdAttempt(inner: typeof fetch): typeof fetch {
  const last = new Map<string, unknown>();

  return async (input, init) => {
    const mapKey = requestMapKey(input, init);
    const peek = input instanceof Request ? input : new Request(input, init);
    const sig = paymentHeaderValue(peek.headers);
    let callInput: Parameters<typeof fetch>[0] = input;
    let callInit = init;
    if (sig) {
      const challenge = last.get(mapKey);
      if (challenge) {
        const stamped = stampPaymentSignatureHeader(sig, challenge);
        if (stamped !== sig) {
          const headers = new Headers(peek.headers);
          if (headers.get("PAYMENT-SIGNATURE")) headers.set("PAYMENT-SIGNATURE", stamped);
          if (headers.get("X-PAYMENT")) headers.set("X-PAYMENT", stamped);
          callInput = new Request(peek, { headers });
          callInit = undefined;
        }
      }
    }

    const resp = await inner(callInput, callInit);
    if (resp.status === 402) {
      try {
        const challenge = await paymentRequiredFromResponse(resp);
        if (challenge) {
          last.set(mapKey, challenge);
          while (last.size > 256) {
            last.delete(last.keys().next().value!);
          }
        }
      } catch {
        /* echo is advisory — never fail-close a 402 on a bad header */
      }
    }
    return resp;
  };
}

/**
 * Wrap `createPaymentPayload` so `@x402/fetch` retries carry `twzrd_attempt`
 * inside the encoded PAYMENT-SIGNATURE, not only on the HTTP wrapper.
 * No-op when the object has no such method (plain signers).
 */
export function wrapX402ClientEchoAttempt<T>(client: T): T {
  if (!client || typeof client !== "object") return client;
  const orig = (client as { createPaymentPayload?: unknown }).createPaymentPayload;
  if (typeof orig !== "function") return client;
  const bound = orig.bind(client) as (
    paymentRequired: unknown,
    ...rest: unknown[]
  ) => unknown;
  const wrapped = async (paymentRequired: unknown, ...rest: unknown[]) => {
    const payload = await bound(paymentRequired, ...rest);
    return stampTwzrdAttemptOnPaymentPayload(paymentRequired, payload);
  };
  try {
    (client as unknown as { createPaymentPayload: unknown }).createPaymentPayload = wrapped;
  } catch {
    return client;
  }
  return client;
}
