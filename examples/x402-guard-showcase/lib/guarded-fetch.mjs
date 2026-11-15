// createGuardedX402FetchWithEvents: the gate's createGuardedX402Fetch on an
// @x402/fetch client, with three things a caller would otherwise wire by hand:
//
// - a .kill / .pause check before the request is sent, so a halted agent
//   sends nothing (the gate reads both again right before the signer);
// - one decision record per call (onDecision), and onKill when the refusal
//   came from .kill or .pause;
// - an optional check of a V7 receipt in the paid response with
//   twzrd-receipt-verifier (onReceiptVerified).
//
// Apart from that entry check, every allow and every refusal is the gate's (or
// another hook's on the same client). This file reads what was decided and
// reports it, and a callback that throws or rejects is ignored.
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

import { createGuardedX402Fetch, isUsdcRequirement, twzrdSentinelRefusal } from "twzrd-x402-gate";
import verifier from "twzrd-receipt-verifier";

const { verify, CURRENT_RECEIPT_PUBKEY } = verifier;

const TAG = "[twzrd-guarded-fetch] ";
const ABORTED = "Payment creation aborted: ";
// How the gate rewraps a refusal by @x402/core's own spend controls, which run
// while the offer is selected: before any hook, so before the signer.
const CORE_SPEND_CONTROLS = "@x402/core refused this payment with its own default spend controls";
const HALT_REASON = /^(?:twzrd_kill_switch|twzrd_pause_corrupt|twzrd_payment_paused)\b/;

const CHAINS = Object.freeze({
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "solana-devnet",
});

const wired = new WeakSet();

/** True for a refusal by .kill or .pause. */
export const isHaltReason = (reason) => typeof reason === "string" && HALT_REASON.test(reason);

/** Milliseconds rounded to the microsecond, as decision records carry them. */
export const roundMs = (ms) => Math.round(ms * 1000) / 1000;

/** USDC base units (6 decimals) as an exact decimal with at least two places; null if not an integer string. */
export function usdcFromBaseUnits(amount) {
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
  const units = BigInt(amount);
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${units / 1_000_000n}.${fraction}`;
}

/** The offer fields a decision record carries. All null when no offer was read. */
export function describeOffer(offer) {
  if (offer === null || typeof offer !== "object") {
    return { chain: null, network: null, asset: null, assetAddress: null, payTo: null, amount: null, amountUsdc: null };
  }
  const text = (value) => (typeof value === "string" ? value : null);
  const network = text(offer.network);
  const amount = text(offer.amount) ?? text(offer.maxAmountRequired);
  const usdc = isUsdcRequirement(offer);
  return {
    chain: network === null ? null : (CHAINS[network] ?? network),
    network,
    asset: usdc ? "USDC" : "non-USDC",
    assetAddress: text(offer.asset),
    payTo: text(offer.payTo),
    amount,
    amountUsdc: usdc ? usdcFromBaseUnits(amount) : null,
  };
}

/**
 * The refusal in an error a guarded fetch threw: `{ reason, preSign }`, or
 * null when the error is not a refusal. `preSign` is true when an x402
 * before-payment hook refused (core's "Payment creation aborted"), and when
 * core's own spend controls did (reason `core_spend_controls`).
 */
export function refusalOf(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const tagged = message.indexOf(TAG);
  const aborted = message.indexOf(ABORTED);
  const firstLine = (s) => s.split("\n")[0].trim();
  if (tagged >= 0) return { reason: firstLine(message.slice(tagged + TAG.length)), preSign: aborted >= 0 && aborted < tagged };
  if (message.includes(CORE_SPEND_CONTROLS)) return { reason: "core_spend_controls", preSign: true };
  if (aborted >= 0) {
    return { reason: firstLine(message.slice(aborted + ABORTED.length)).replace(/^\[[^\]]*\]\s*/, ""), preSign: true };
  }
  return null;
}

function safely(callback, value) {
  if (typeof callback !== "function") return;
  try {
    const result = callback(value);
    // An async callback is not awaited, and its rejection is dropped: it never
    // becomes an unhandled rejection, which Node turns into a crash by default.
    if (typeof result?.then === "function") result.then(undefined, () => {});
  } catch {
    // Telemetry never changes what was paid or refused.
  }
}

/**
 * Check a signed receipt offline with twzrd-receipt-verifier against a pinned
 * issuer key (default: the key the package pins). No I/O. Returns the event
 * it hands to onReceiptVerified.
 */
export function verifyReceipt(receipt, { pubkey = CURRENT_RECEIPT_PUBKEY, maxAgeSeconds, onReceiptVerified } = {}) {
  let result;
  try {
    result = verify(receipt, pubkey, maxAgeSeconds === undefined ? undefined : { maxAgeSeconds });
  } catch (error) {
    result = { valid: false, leaf_valid: false, signature_valid: false, errors: [`verifier threw: ${error?.message ?? error}`] };
  }
  const preimage = receipt !== null && typeof receipt === "object" ? receipt.preimage : undefined;
  const event = {
    valid: result.valid === true,
    leafValid: result.leaf_valid ?? null,
    signatureValid: result.signature_valid ?? null,
    errors: Array.isArray(result.errors) ? [...result.errors] : [],
    kind: receipt?.kind ?? null,
    subject: preimage?.agent_id ?? null,
    score: preimage?.score ?? null,
    issuedAtUnix: preimage?.timestamp_unix ?? null,
    trustedPubkey: pubkey,
  };
  safely(onReceiptVerified, event);
  return event;
}

/** Default receipt extractor: `twzrd_receipt` in a JSON body, as TWZRD's paid trust route returns it. */
async function receiptInBody(response) {
  const body = await response.json();
  return body !== null && typeof body === "object" ? (body.twzrd_receipt ?? null) : null;
}

/**
 * A paying fetch for a configured @x402/core x402Client: the gate's
 * createGuardedX402Fetch, with typed events.
 *
 *   const pay = createGuardedX402FetchWithEvents({ client, maxPricePerCall: "0.10", onDecision: console.log });
 *   const res = await pay(url);
 *
 * Options are createGuardedX402Fetch's (client, fetch, maxPricePerCall,
 * hourlyBudgetCap, allowedRecipients, twzrd, ...) plus:
 *   onDecision(record)       once per call: allow, block or error, and why
 *   onKill(record)           a call refused by .kill or .pause
 *   onReceiptVerified(event) a receipt in the paid response was checked
 *   receipt                  true, or { extract, pubkey, maxAgeSeconds }: check the
 *                            receipt in a paid 2xx response (default extract reads
 *                            `twzrd_receipt` from the JSON body)
 *
 * A refusal throws, as createGuardedX402Fetch does; the record says why. Hooks
 * registered on the client after this call run after the gate's last look,
 * between it and the signer: register your own hooks first.
 */
export function createGuardedX402FetchWithEvents(options) {
  const { onDecision, onKill, onReceiptVerified, receipt, ...gateOptions } = options ?? {};
  const client = gateOptions.client;
  for (const method of ["onBeforePaymentCreation", "onAfterPaymentCreation", "onPaymentCreationFailure"]) {
    if (typeof client?.[method] !== "function") {
      throw new TypeError(`createGuardedX402FetchWithEvents needs a configured @x402/core x402Client (no ${method})`);
    }
  }
  if (wired.has(client)) throw new Error("createGuardedX402FetchWithEvents is already installed on this client");
  const receiptOptions = receipt === true ? {} : receipt || null;

  // Registered before the gate's own hooks, so they run first: core runs hooks
  // in registration order, an abort ends the before-hooks, and the gate's
  // failure hook rethrows, which ends the failure hooks.
  const calls = new AsyncLocalStorage();
  client.onBeforePaymentCreation(async (context) => {
    const call = calls.getStore();
    if (call) call.offer = context?.selectedRequirements ?? null;
  });
  // The scheme is the signer: count each payload it built, and each time it threw.
  client.onAfterPaymentCreation(async () => {
    const call = calls.getStore();
    if (call) call.signerInvocations += 1;
  });
  client.onPaymentCreationFailure(async () => {
    const call = calls.getStore();
    if (call) call.signerInvocations += 1;
  });
  const guarded = createGuardedX402Fetch(gateOptions);
  wired.add(client);

  const report = (record) => {
    safely(onDecision, record);
    if (record.decision === "block" && isHaltReason(record.reason)) safely(onKill, record);
  };

  return function guardedFetch(input, init) {
    const started = performance.now();
    const call = { offer: null, signerInvocations: 0 };
    const record = ({ decision, reason = null, stage = null, status = null, receiptVerified = null }) => ({
      ...describeOffer(call.offer),
      decision,
      reason,
      stage,
      signerInvocations: call.signerInvocations,
      status,
      receiptVerified,
      elapsedMs: roundMs(performance.now() - started),
    });
    return calls.run(call, async () => {
      // Halted: refuse before any request is made.
      const halted = twzrdSentinelRefusal(gateOptions.twzrd);
      if (halted !== undefined) {
        report(record({ decision: "block", reason: halted, stage: "entry" }));
        throw new Error(`${TAG}${halted}`);
      }
      let response;
      try {
        response = await guarded(input, init);
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal) {
          const stage = refusal.preSign ? "pre_sign" : call.signerInvocations > 0 ? "transport" : "entry";
          report(record({ decision: "block", reason: refusal.reason, stage }));
        } else {
          report(record({ decision: "error", reason: String(error?.message ?? error).slice(0, 300) }));
        }
        throw error;
      }
      const paid = call.signerInvocations > 0;
      let receiptVerified = null;
      if (receiptOptions && paid && response.ok) {
        let found = null;
        try {
          found = await (receiptOptions.extract ?? receiptInBody)(response.clone());
        } catch {
          found = null;
        }
        if (found !== null && found !== undefined) {
          receiptVerified = verifyReceipt(found, { ...receiptOptions, onReceiptVerified }).valid;
        }
      }
      report(record({ decision: "allow", stage: paid ? "pre_sign" : null, status: response.status, receiptVerified }));
      return response;
    });
  };
}
