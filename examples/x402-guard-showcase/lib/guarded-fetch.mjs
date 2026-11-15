// Two guarded paying fetches with the same decision records:
//
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
//
// createGuardedX402SolanaFetch: the same on the stock x402-solana client. The
// gate has no guarded fetch for that client, so this one applies
// createGuardedX402Fetch's local checks itself, with the same reasons, in the
// client's beforePayment hook, then the gate's own x402-solana seat
// (installTwzrdAutoGate). It reads .kill / .pause on entry, in the hook, and
// in the wallet right before the real signer.
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

import {
  createGuardedX402Fetch,
  installTwzrdAutoGate,
  isUsdcRequirement,
  resolveRequirementFields,
  toMicroUsd,
  twzrdSentinelRefusal,
} from "twzrd-x402-gate";
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

/** receiptVerified for a paid 2xx response: true or false when a receipt was found and checked, else null. */
async function receiptVerdict(receiptOptions, response, onReceiptVerified) {
  let found = null;
  try {
    found = await (receiptOptions.extract ?? receiptInBody)(response.clone());
  } catch {
    found = null;
  }
  if (found === null || found === undefined) return null;
  return verifyReceipt(found, { ...receiptOptions, onReceiptVerified }).valid;
}

/** One decision record per call to onDecision, and to onKill when .kill or .pause refused it. */
function reporter(onDecision, onKill) {
  return (record) => {
    safely(onDecision, record);
    if (record.decision === "block" && isHaltReason(record.reason)) safely(onKill, record);
  };
}

/** Builds a call's decision record from what the call saw. */
function recorder(call, started) {
  return ({ decision, reason = null, stage = null, status = null, receiptVerified = null }) => ({
    ...describeOffer(call.offer),
    decision,
    reason,
    stage,
    signerInvocations: call.signerInvocations,
    status,
    receiptVerified,
    elapsedMs: roundMs(performance.now() - started),
  });
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
  const report = reporter(onDecision, onKill);

  return function guardedFetch(input, init) {
    const call = { offer: null, signerInvocations: 0 };
    const record = recorder(call, performance.now());
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
      const receiptVerified =
        receiptOptions && paid && response.ok ? await receiptVerdict(receiptOptions, response, onReceiptVerified) : null;
      report(record({ decision: "allow", stage: paid ? "pre_sign" : null, status: response.status, receiptVerified }));
      return response;
    });
  };
}

const HOUR_MS = 3_600_000;
// The networks each x402-solana `network` setting may pay on, in the v1 and
// v2 (CAIP-2) spellings. The stock client takes the first "exact" offer on
// any Solana network; this keeps it on the cluster it was configured for.
const SOLANA_CLUSTERS = Object.freeze({
  solana: new Set(["solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]),
  "solana-devnet": new Set(["solana-devnet", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]),
});
const SOLANA_FETCH_OPTIONS = new Set([
  "createX402Client",
  "wallet",
  "network",
  "rpcUrl",
  "customFetch",
  "verbose",
  "maxPricePerCall",
  "hourlyBudgetCap",
  "allowedRecipients",
  "twzrd",
  "onDecision",
  "onKill",
  "onReceiptVerified",
  "receipt",
]);

/** A USDC limit in micro-units, read as createGuardedX402Fetch reads it. */
function parseUsdcLimit(value, label) {
  if (value === undefined) return undefined;
  try {
    return toMicroUsd(typeof value === "number" ? String(value) : value);
  } catch {
    throw new TypeError(`createGuardedX402SolanaFetch: ${label} must be a non-negative USDC decimal with at most 6 fractional digits`);
  }
}

/** A refusal reason as a record carries it: the first line, without a leading [tag]. */
const plainReason = (reason) =>
  String(reason ?? "")
    .split("\n")[0]
    .trim()
    .replace(/^\[[^\]]*\]\s*/, "");

/**
 * A paying fetch on the stock x402-solana client (createX402Client from
 * "x402-solana/client"), with the same checks, halts and decision records as
 * createGuardedX402FetchWithEvents:
 *
 *   import { createX402Client } from "x402-solana/client";
 *   const pay = createGuardedX402SolanaFetch({ createX402Client, wallet, rpcUrl, maxPricePerCall: "0.10", onDecision: console.log });
 *   const res = await pay(url);
 *
 * It builds the client with its own beforePayment hook and a wrapper around
 * the wallet. Before any request, .kill and .pause. In beforePayment, on the
 * one offer x402-solana selected, with nothing awaited between the checks and
 * the budget reservation:
 *   .kill / .pause                        twzrd_kill_switch, twzrd_pause_corrupt, twzrd_payment_paused
 *   the offer is on the configured cluster network_not_allowed
 *   the gate's field checks               (resolveRequirementFields' reasons)
 *   allowedRecipients                     recipient_missing, unauthorized_recipient
 *   with a spend rule: USDC only           unsupported_or_non_usdc_asset
 *   with a spend rule: a base-unit amount  amount_missing_or_malformed
 *   maxPricePerCall                       price_cap_exceeded
 *   hourlyBudgetCap                       hourly_budget_exceeded
 * then the gate's x402-solana seat (installTwzrdAutoGate), which runs the TWZRD
 * evaluator unless twzrd.disabled and reads .kill / .pause either way. In the
 * wallet, right before the real signTransaction: .kill / .pause once more.
 * x402-solana reads the chain between its hook and the signer (the mint, both
 * token accounts, a blockhash), so a halt written during those reads is seen
 * there, not missed.
 *
 * The hourly budget counts each payment the wallet was asked to sign. An
 * approved amount stays reserved while the client builds the transaction, so
 * concurrent calls cannot overspend; it is released if the call ends unsigned.
 *
 * Options: createX402Client and wallet (required), network ("solana", the
 * default, or "solana-devnet"), rpcUrl, customFetch and verbose (passed to
 * x402-solana), maxPricePerCall, hourlyBudgetCap, allowedRecipients, twzrd
 * (the seat's options: sentinel paths, disabled, ...), onDecision, onKill,
 * onReceiptVerified and receipt, as createGuardedX402FetchWithEvents takes
 * them. Any other option is refused rather than ignored, x402-solana's own
 * `amount` and `beforePayment` included: maxPricePerCall and this hook govern.
 * A refusal throws; the record says why.
 */
export function createGuardedX402SolanaFetch(options) {
  const opts = options ?? {};
  const unsupported = Object.keys(opts).filter((key) => !SOLANA_FETCH_OPTIONS.has(key));
  if (unsupported.length > 0) {
    throw new TypeError(`createGuardedX402SolanaFetch does not take ${unsupported.join(", ")}: an option it would not enforce is refused, not ignored`);
  }
  const { createX402Client, wallet, network = "solana", rpcUrl, customFetch, verbose, allowedRecipients, twzrd = {} } = opts;
  const { onDecision, onKill, onReceiptVerified, receipt } = opts;
  if (typeof createX402Client !== "function") {
    throw new TypeError("createGuardedX402SolanaFetch needs createX402Client from x402-solana/client");
  }
  if (typeof wallet?.signTransaction !== "function") {
    throw new TypeError("createGuardedX402SolanaFetch needs a wallet with signTransaction");
  }
  const cluster = SOLANA_CLUSTERS[network];
  if (!cluster) throw new TypeError(`createGuardedX402SolanaFetch: network must be "solana" or "solana-devnet"`);
  const maxPerCall = parseUsdcLimit(opts.maxPricePerCall, "maxPricePerCall");
  const hourlyCap = parseUsdcLimit(opts.hourlyBudgetCap, "hourlyBudgetCap");
  if (allowedRecipients !== undefined && !(Array.isArray(allowedRecipients) && allowedRecipients.every((a) => typeof a === "string"))) {
    throw new TypeError("createGuardedX402SolanaFetch: allowedRecipients must be an array of addresses");
  }
  // Base58 addresses are case-sensitive: an exact match, as the gate does for Solana.
  const recipients = allowedRecipients === undefined ? undefined : new Set(allowedRecipients);
  const receiptOptions = receipt === true ? {} : receipt || null;
  const seat = installTwzrdAutoGate("x402-solana", twzrd);

  const calls = new AsyncLocalStorage();
  const entries = []; // { at, micro }: payments the wallet was asked to sign, for the hourly budget
  let pendingMicro = 0n; // approved, not yet signed
  const release = (call) => {
    if (call.reservedMicro > 0n) pendingMicro -= call.reservedMicro;
    call.reservedMicro = 0n;
  };
  const refuse = (call, reason) => {
    call.refusal = plainReason(reason);
    return { abort: true, reason };
  };
  const refuseLocally = (call, reason) => refuse(call, `${TAG}${reason}`);

  async function beforePayment(requirements, context) {
    const call = calls.getStore() ?? { offer: null, signerInvocations: 0, refusal: null, reservedMicro: 0n };
    call.offer = requirements ?? null;
    const halted = twzrdSentinelRefusal(twzrd);
    if (halted !== undefined) return refuseLocally(call, halted);
    const selected = requirements ?? {};
    if (!cluster.has(selected.network)) return refuseLocally(call, "network_not_allowed");
    const fields = resolveRequirementFields(selected);
    if (fields.conflict) return refuseLocally(call, fields.conflict);
    if (recipients !== undefined) {
      if (!fields.payTo) return refuseLocally(call, "recipient_missing");
      if (!recipients.has(fields.payTo)) return refuseLocally(call, "unauthorized_recipient");
    }
    let amountMicro;
    if (maxPerCall !== undefined || hourlyCap !== undefined) {
      if (!isUsdcRequirement(selected)) return refuseLocally(call, "unsupported_or_non_usdc_asset");
      if (fields.amount === undefined || !/^\d+$/.test(fields.amount)) return refuseLocally(call, "amount_missing_or_malformed");
      amountMicro = BigInt(fields.amount);
      if (maxPerCall !== undefined && amountMicro > maxPerCall) return refuseLocally(call, "price_cap_exceeded");
    }
    if (hourlyCap !== undefined) {
      const cutoff = Date.now() - HOUR_MS;
      while (entries.length > 0 && entries[0].at <= cutoff) entries.shift();
      const spent = entries.reduce((sum, entry) => sum + entry.micro, 0n);
      if (spent + pendingMicro + amountMicro > hourlyCap) return refuseLocally(call, "hourly_budget_exceeded");
      // No await between the check and the reservation.
      pendingMicro += amountMicro;
      call.reservedMicro = amountMicro;
    }
    let decision;
    try {
      decision = await seat(requirements, context);
    } catch (error) {
      release(call);
      throw error;
    }
    if (decision?.abort) {
      release(call);
      return refuse(call, decision.reason ?? "beforePayment hook aborted payment");
    }
    return undefined;
  }

  // The wallet x402-solana signs with: the caller's, behind one more look at
  // .kill and .pause. Nothing is awaited between that look and the signer.
  const guardedWallet = {
    get publicKey() {
      return wallet.publicKey;
    },
    get address() {
      return wallet.address;
    },
    signTransaction(transaction) {
      const call = calls.getStore();
      const halted = twzrdSentinelRefusal(twzrd);
      if (halted !== undefined) {
        if (call) {
          release(call);
          call.refusal = halted;
        }
        return Promise.reject(new Error(`${TAG}${halted}`));
      }
      if (call) {
        if (call.reservedMicro > 0n) {
          entries.push({ at: Date.now(), micro: call.reservedMicro });
          release(call);
        }
        call.signerInvocations += 1;
      }
      return wallet.signTransaction(transaction);
    },
  };

  const client = createX402Client({
    wallet: guardedWallet,
    network,
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
    ...(customFetch === undefined ? {} : { customFetch }),
    ...(verbose === undefined ? {} : { verbose }),
    beforePayment,
  });
  if (typeof client?.fetch !== "function") {
    throw new TypeError("createGuardedX402SolanaFetch: createX402Client did not return a client with fetch");
  }
  const report = reporter(onDecision, onKill);

  return function guardedSolanaFetch(input, init) {
    const call = { offer: null, signerInvocations: 0, refusal: null, reservedMicro: 0n };
    const record = recorder(call, performance.now());
    return calls.run(call, async () => {
      // Halted: refuse before any request is made.
      const halted = twzrdSentinelRefusal(twzrd);
      if (halted !== undefined) {
        report(record({ decision: "block", reason: halted, stage: "entry" }));
        throw new Error(`${TAG}${halted}`);
      }
      let response;
      try {
        response = await client.fetch(input, init);
      } catch (error) {
        if (call.refusal !== null) report(record({ decision: "block", reason: call.refusal, stage: "pre_sign" }));
        else report(record({ decision: "error", reason: String(error?.message ?? error).slice(0, 300) }));
        throw error;
      } finally {
        release(call);
      }
      const paid = call.signerInvocations > 0;
      const receiptVerified =
        receiptOptions && paid && response.ok ? await receiptVerdict(receiptOptions, response, onReceiptVerified) : null;
      report(record({ decision: "allow", stage: paid ? "pre_sign" : null, status: response.status, receiptVerified }));
      return response;
    });
  };
}
