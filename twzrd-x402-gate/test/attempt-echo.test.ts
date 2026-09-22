/**
 * Client echo of extensions.twzrd_attempt — never mint, header-first 402.
 * Run: npx tsx test/attempt-echo.test.ts
 */
import assert from "node:assert/strict";

import {
  ATTEMPT_EXTENSION,
  ATTEMPT_EXTENSION_SCHEMA,
  stampPaymentSignatureHeader,
  stampTwzrdAttemptOnPaymentPayload,
  twzrdAttemptFromChallenge,
  wrapFetchEchoTwzrdAttempt,
  wrapX402ClientEchoAttempt,
} from "../src/attempt-echo.js";

const KEY = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ATTEMPT = { schema: ATTEMPT_EXTENSION_SCHEMA, attempt_key: KEY };

function challenge(extra?: Record<string, unknown>) {
  return {
    x402Version: 2,
    accepts: [{ payTo: "MERCHANT", amount: "1000", network: "solana" }],
    extensions: { twzrd_attempt: ATTEMPT, bazaar: { keep: true } },
    ...extra,
  };
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

async function run() {
  // 1. Extract from extensions.twzrd_attempt; ignore whitespace-only keys.
  {
    assert.deepEqual(twzrdAttemptFromChallenge(challenge()), ATTEMPT);
    assert.equal(twzrdAttemptFromChallenge({ extensions: { twzrd_attempt: { attempt_key: "  " } } }), null);
    assert.equal(twzrdAttemptFromChallenge({ attempt_key: KEY }), null, "never synthesize from body.attempt_key");
    assert.equal(twzrdAttemptFromChallenge({ extensions: {} }), null);
    assert.equal(twzrdAttemptFromChallenge(null), null);
  }

  // 2. Stamp copies the challenge extension onto the payload. Never mints.
  {
    const stamped = stampTwzrdAttemptOnPaymentPayload(challenge(), {
      x402Version: 2,
      payload: { transaction: "tx" },
      extensions: { bazaar: { keep: true } },
    }) as { extensions: Record<string, unknown> };
    assert.deepEqual(stamped.extensions.twzrd_attempt, ATTEMPT);
    assert.deepEqual(stamped.extensions.bazaar, { keep: true });

    const untouched = { x402Version: 2, payload: {} };
    assert.equal(stampTwzrdAttemptOnPaymentPayload({ extensions: {} }, untouched), untouched);
  }

  // 3. Do not overwrite a payload that already echoed a key.
  {
    const existing = {
      extensions: { twzrd_attempt: { schema: ATTEMPT_EXTENSION_SCHEMA, attempt_key: "already" } },
    };
    assert.equal(stampTwzrdAttemptOnPaymentPayload(challenge(), existing), existing);
  }

  // 4. PAYMENT-SIGNATURE header round-trip.
  {
    const raw = b64({ x402Version: 2, payload: { transaction: "tx" } });
    const out = stampPaymentSignatureHeader(raw, challenge());
    const decoded = JSON.parse(Buffer.from(out, "base64").toString("utf8"));
    assert.deepEqual(decoded.extensions[ATTEMPT_EXTENSION], ATTEMPT);
    assert.equal(stampPaymentSignatureHeader("!!!not-b64!!!", challenge()), "!!!not-b64!!!");
  }

  // 5. wrapFetchEchoTwzrdAttempt: PAYMENT-REQUIRED header wins over a decoy body;
  //    retry PAYMENT-SIGNATURE carries the header's key.
  {
    const headerChallenge = challenge();
    const decoy = { accepts: [], extensions: { twzrd_attempt: { attempt_key: "decoy" } } };
    let seenSig: string | null = null;
    const inner = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const sig = req.headers.get("PAYMENT-SIGNATURE");
      if (sig) {
        seenSig = sig;
        return new Response("paid", { status: 200 });
      }
      return new Response(JSON.stringify(decoy), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": b64(headerChallenge),
        },
      });
    }) as typeof fetch;

    const echoing = wrapFetchEchoTwzrdAttempt(inner);
    const first = await echoing("https://merchant.example/paid");
    assert.equal(first.status, 402);

    const unsigned = b64({ x402Version: 2, payload: { transaction: "tx" } });
    const retry = await echoing("https://merchant.example/paid", {
      headers: { "PAYMENT-SIGNATURE": unsigned },
    });
    assert.equal(retry.status, 200);
    assert.ok(seenSig);
    const payload = JSON.parse(Buffer.from(seenSig!, "base64").toString("utf8"));
    assert.equal(payload.extensions.twzrd_attempt.attempt_key, KEY);
    assert.notEqual(payload.extensions.twzrd_attempt.attempt_key, "decoy");
  }

  // 6. Body-only 402 (no header) still echoes — fallback after header-first miss.
  {
    let seen: unknown;
    const inner = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const sig = req.headers.get("PAYMENT-SIGNATURE");
      if (sig) {
        seen = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
        return new Response("ok", { status: 200 });
      }
      return new Response(JSON.stringify(challenge()), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const echoing = wrapFetchEchoTwzrdAttempt(inner);
    await echoing("https://merchant.example/body-only");
    await echoing("https://merchant.example/body-only", {
      headers: { "PAYMENT-SIGNATURE": b64({ x402Version: 2 }) },
    });
    assert.equal(
      (seen as { extensions: { twzrd_attempt: { attempt_key: string } } }).extensions.twzrd_attempt
        .attempt_key,
      KEY,
    );
  }

  // 7. wrapX402ClientEchoAttempt stamps after createPaymentPayload; missing method is a no-op.
  {
    const client = {
      async createPaymentPayload(_pr: unknown) {
        return { x402Version: 2, payload: { transaction: "tx" } };
      },
    };
    wrapX402ClientEchoAttempt(client);
    const payload = (await client.createPaymentPayload(challenge())) as unknown as {
      extensions: { twzrd_attempt: { attempt_key: string } };
    };
    assert.equal(payload.extensions.twzrd_attempt.attempt_key, KEY);

    const signer = { sign: () => "sig" };
    assert.equal(wrapX402ClientEchoAttempt(signer), signer);
  }

  console.log("attempt-echo.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("attempt-echo.test.ts FAILED:", e);
  process.exit(1);
});
