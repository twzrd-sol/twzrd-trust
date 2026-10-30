import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { isTwzrdAutoGateDisabled } from "./auto-gate.js";
import { wrapFetchRecordFulfillment, type FulfillmentRecord } from "./fulfillment-record.js";
import { createOutcomeLedgerX402Binding, type OutcomeLedgerX402Options } from "./outcome-ledger-x402.js";
import type { OutcomeLedger } from "./outcome-ledger.js";
import { toMicroUsd } from "./intent.js";
import { PAYMENT_DECISION_SCHEMA } from "./payment-decision.js";
import { isUsdcRequirement, resolveRequirementFields } from "./payto.js";
import {
  createTwzrdPayKitBeforePaymentHook,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type InstallX402ClientHookOptions,
  type X402ClientLike,
} from "./x402-client-hook.js";

const HOUR_MS = 60 * 60 * 1000;
const guardedClients = new WeakSet<object>();

export type GuardedX402FetchOptions = {
  /** Configured x402 client with its payment schemes and wallet signer. */
  client: X402ClientLike;
  /** Raw HTTP transport. The returned fetch handles x402 402 challenges. */
  fetch?: typeof fetch;
  /** Maximum amount for one payment, in USDC (six decimal places). */
  maxPricePerCall?: number | string;
  /** Maximum spend in a rolling 60-minute window, in USDC. */
  hourlyBudgetCap?: number | string;
  /** If provided, only these payTo values are allowed. An empty list denies all. */
  allowedRecipients?: readonly string[];
  /** Options passed to the existing TWZRD x402 pre-sign evaluator. */
  twzrd?: Omit<InstallX402ClientHookOptions, "x402Fetch"> & { disabled?: boolean };
  /** Injectable clock for deterministic host-side integrations. */
  now?: () => number;
  /**
   * A vault-spend transaction this process already holds. Checked before any
   * fetch or RPC socket. Absent on the ordinary 402 path. This gate is not
   * the exclusive signer: refusing the copy does not stop a direct submission
   * of bytes the Demand Desk already signed.
   */
  heldVaultSpend?: HeldVaultSpendCopy;
  /**
   * Opt-in local fulfillment record for each paid call: who was paid, the
   * settlement tx, who the seller says served, and readiness. Never sent
   * anywhere; never changes what is allowed or refused. Pass
   * `createFileFulfillmentLog(path).record` to keep a JSONL file.
   */
  onFulfillment?: (record: FulfillmentRecord) => void;
  /**
   * Opt-in outcome ledger (outcome-ledger.ts). One durable record per
   * attempt, keyed on the intent hash of the selected requirement + request.
   * The `signing` row is appended BEFORE the scheme signs; a paid retry that
   * throws or returns no PAYMENT-RESPONSE leaves the record `unknown`, and a
   * later call for the same intent aborts in the hook (`unresolved_attempt`)
   * until the record is reconciled. Pass a ledger, or options with a
   * validator for the paid response. See docs/OUTCOME_CONTRACT.md.
   */
  outcomeLedger?: OutcomeLedger | OutcomeLedgerX402Options;
};

type SpendEntry = { at: number; micro: bigint };

function parseLimit(value: number | string | undefined, label: string): bigint | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "number" ? String(value) : value;
  try {
    return toMicroUsd(text);
  } catch {
    throw new TypeError(`[twzrd-x402-gate] ${label} must be a non-negative USDC decimal with at most 6 fractional digits`);
  }
}

function recipientMatches(payTo: string, allowed: readonly string[]): boolean {
  // EVM addresses are case-insensitive; Solana base58 addresses are not.
  const key = payTo.startsWith("0x") ? payTo.toLowerCase() : payTo;
  return allowed.some((candidate) =>
    (candidate.startsWith("0x") ? candidate.toLowerCase() : candidate) === key,
  );
}


function abort(reason: string): BeforePaymentCreationResult {
  return { abort: true, reason: `[twzrd-guarded-fetch] ${reason}` };
}

/** Deployed budget vault. The program is immutable and is not replaced here. */
export const VAULT_PROGRAM_ID = "4sJCaNbz7HUz58qsA6vtFefPq2RBaN9o4mZ1gXBZryGS";
/** Settlement mint. USDC, not a desk capability mint. */
export const SETTLEMENT_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SPEND_DISCRIMINATOR = createHash("sha256").update("global:spend_with_policy").digest().subarray(0, 8);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type HeldVaultSpendCopy = {
  /** Exact transaction bytes already in hand. This function does not fetch them. */
  serializedTransaction: string;
  /** Pinned Demand Desk Ed25519 public key, base58. */
  demandDeskPubkey: string;
  /** Short capability expiry, unix seconds. */
  expiresAtTs: number;
  nowTs: number;
  /** spend_with_policy instruction data the capability binds, hex. */
  boundInstructionHex: string;
  /**
   * Optional advisory `twzrd.payment_decision.v1`. Never sufficient to move USDC.
   */
  advisoryPaymentDecision?: unknown;
};

export type HeldVaultSpendVerdict = {
  refused: boolean;
  reason: string;
  /** This check does not open a socket. The count on a refusal is 0. */
  rpc_sockets_opened: 0;
};

function base58Decode(text: string): Buffer | null {
  if (text.length === 0) return null;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i += 1) {
    const value = B58.indexOf(text[i]!);
    if (value < 0) return null;
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[out.length - 1 - i] = bytes[i]!;
  return out;
}

function readShortvec(buf: Buffer, offset: number): { value: number; offset: number } | null {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 3; i += 1) {
    if (offset >= buf.length) return null;
    const byte = buf[offset]!;
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  return null;
}

type ParsedSpend = {
  message: Buffer;
  signatures: Buffer[];
  accountKeys: Buffer[];
  requiredSignatures: number;
  instructionData: Buffer;
  mint: Buffer;
};

function parseVaultSpend(raw: Buffer): ParsedSpend | null {
  let offset = 0;
  const sigCount = readShortvec(raw, offset);
  if (!sigCount || sigCount.value < 1 || sigCount.value > 16) return null;
  offset = sigCount.offset;
  const signatures: Buffer[] = [];
  for (let i = 0; i < sigCount.value; i += 1) {
    if (offset + 64 > raw.length) return null;
    signatures.push(raw.subarray(offset, offset + 64));
    offset += 64;
  }
  const messageStart = offset;
  if (offset + 3 > raw.length) return null;
  const requiredSignatures = raw[offset]!;
  offset += 3;
  const keyCount = readShortvec(raw, offset);
  if (!keyCount || keyCount.value < 1 || keyCount.value > 64) return null;
  offset = keyCount.offset;
  const accountKeys: Buffer[] = [];
  for (let i = 0; i < keyCount.value; i += 1) {
    if (offset + 32 > raw.length) return null;
    accountKeys.push(raw.subarray(offset, offset + 32));
    offset += 32;
  }
  if (offset + 32 > raw.length) return null;
  offset += 32;
  const ixCount = readShortvec(raw, offset);
  if (!ixCount || ixCount.value !== 1) return null;
  offset = ixCount.offset;
  if (offset >= raw.length) return null;
  const programIndex = raw[offset]!;
  offset += 1;
  if (programIndex >= accountKeys.length) return null;
  const program = accountKeys[programIndex]!;
  const vault = base58Decode(VAULT_PROGRAM_ID);
  if (!vault || program.length !== vault.length || !program.equals(vault)) return null;
  const accounts = readShortvec(raw, offset);
  if (!accounts || accounts.value !== 7) return null;
  offset = accounts.offset;
  if (offset + 7 > raw.length) return null;
  const indexes = [...raw.subarray(offset, offset + 7)];
  offset += 7;
  if (indexes.some((index) => index >= accountKeys.length)) return null;
  const dataLen = readShortvec(raw, offset);
  if (!dataLen || dataLen.value !== 49) return null;
  offset = dataLen.offset;
  if (offset + 49 > raw.length) return null;
  const instructionData = raw.subarray(offset, offset + 49);
  if (!instructionData.subarray(0, 8).equals(SPEND_DISCRIMINATOR)) return null;
  const mint = accountKeys[indexes[3]!]!;
  const usdc = base58Decode(SETTLEMENT_USDC_MINT);
  if (!usdc || !mint.equals(usdc)) return null;
  return {
    message: raw.subarray(messageStart),
    signatures,
    accountKeys,
    requiredSignatures,
    instructionData,
    mint,
  };
}

function advisoryOnly(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { schema?: unknown }).schema === PAYMENT_DECISION_SCHEMA,
  );
}

function deskSignature(parsed: ParsedSpend, desk: Buffer): Buffer | null {
  const index = parsed.accountKeys.findIndex((key) => key.equals(desk));
  if (index < 0 || index >= parsed.requiredSignatures || index >= parsed.signatures.length) return null;
  return parsed.signatures[index]!;
}

/**
 * Decide a vault spend from the transaction copy already held.
 * No DNS, no socket, no RPC. A refusal here is about this copy only.
 * `twzrd.payment_decision.v1` is not accepted as the spending credential.
 * This function does not submit the transaction and is not the exclusive signer.
 */
export function decideHeldVaultSpend(copy: HeldVaultSpendCopy): HeldVaultSpendVerdict {
  const refuse = (reason: string): HeldVaultSpendVerdict => ({
    refused: true,
    reason,
    rpc_sockets_opened: 0,
  });
  let raw: Buffer;
  try {
    raw = Buffer.from(copy.serializedTransaction, "base64");
  } catch {
    return refuse("vault_spend_unreadable");
  }
  const parsed = parseVaultSpend(raw);
  if (!parsed) return refuse("vault_spend_unreadable");
  const bound = copy.boundInstructionHex.trim().toLowerCase();
  if (parsed.instructionData.toString("hex") !== bound) return refuse("instruction_bytes_differ");
  const desk = base58Decode(copy.demandDeskPubkey);
  if (!desk || desk.length !== 32) return refuse("missing_demand_desk_signature");
  const signature = deskSignature(parsed, desk);
  const missing = !signature || signature.every((byte) => byte === 0);
  if (missing) {
    return refuse(
      advisoryOnly(copy.advisoryPaymentDecision)
        ? "advisory_payment_decision_does_not_move_usdc"
        : "missing_demand_desk_signature",
    );
  }
  let verified = false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, desk]),
      format: "der",
      type: "spki",
    });
    verified = edVerify(null, parsed.message, key, signature);
  } catch {
    verified = false;
  }
  if (!verified) return refuse("forged_demand_desk_signature");
  if (!Number.isSafeInteger(copy.expiresAtTs) || !Number.isSafeInteger(copy.nowTs) || copy.nowTs >= copy.expiresAtTs) {
    return refuse("authorization_expired");
  }
  return { refused: false, reason: "desk_signature_present", rpc_sockets_opened: 0 };
}

/**
 * Build a paying fetch around a configured x402 client. Local recipient and
 * spend controls run on the selected 402 requirement; the existing TWZRD
 * pre-sign evaluator then runs before the x402 client can create a signature.
 *
 * The rolling budget lives in memory for the lifetime of this returned fetch.
 * It is intentionally conservative: once all pre-sign checks pass, the amount
 * is recorded before the hook returns, so a subsequent signer error still
 * consumes budget.
 */
export function createGuardedX402Fetch(options: GuardedX402FetchOptions): typeof fetch {
  if (!options || !options.client || typeof options.client.onBeforePaymentCreation !== "function") {
    throw new TypeError("[twzrd-x402-gate] createGuardedX402Fetch requires a configured x402 client");
  }
  if (guardedClients.has(options.client as object)) {
    throw new Error("[twzrd-x402-gate] createGuardedX402Fetch is already installed on this client");
  }
  if ((options.twzrd as InstallX402ClientHookOptions | undefined)?.x402Fetch) {
    throw new TypeError(
      "[twzrd-x402-gate] configure a separate guarded x402 client for paid TWZRD Path A; " +
        "an external paying fetch cannot share this hourly ledger",
    );
  }

  const maxPerCall = parseLimit(options.maxPricePerCall, "maxPricePerCall");
  const hourlyCap = parseLimit(options.hourlyBudgetCap, "hourlyBudgetCap");
  const recipients = options.allowedRecipients;
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const outcome = options.outcomeLedger
    ? createOutcomeLedgerX402Binding(
        "begin" in options.outcomeLedger
          ? { ledger: options.outcomeLedger, now }
          : { now, ...options.outcomeLedger },
      )
    : undefined;
  const fulfilled = options.onFulfillment
    ? wrapFetchRecordFulfillment(transport, options.onFulfillment)
    : transport;
  const fetchImpl = outcome ? outcome.wrapTransport(fulfilled) : fulfilled;
  const entries: SpendEntry[] = [];
  let pendingMicro = 0n;
  const twzrdHook = createTwzrdPayKitBeforePaymentHook(options.twzrd);

  const innerHook = async (
    context: BeforePaymentCreationContext,
  ): Promise<BeforePaymentCreationResult> => {
    const selected = context.selectedRequirements ?? context.requirements ?? {};
    const fields = resolveRequirementFields(selected);
    if (fields.conflict) return abort(fields.conflict);

    const payTo = fields.payTo;
    if (recipients !== undefined) {
      if (!payTo) return abort("recipient_missing");
      if (!recipientMatches(payTo, recipients)) return abort("unauthorized_recipient");
    }

    const hasSpendRule = maxPerCall !== undefined || hourlyCap !== undefined;
    let amountMicro: bigint | undefined;
    if (hasSpendRule) {
      if (!isUsdcRequirement(selected as Record<string, unknown>)) {
        return abort("unsupported_or_non_usdc_asset");
      }
      if (fields.amount === undefined || !/^\d+$/.test(fields.amount)) {
        return abort("amount_missing_or_malformed");
      }
      try {
        amountMicro = BigInt(fields.amount);
      } catch {
        return abort("amount_missing_or_malformed");
      }
      if (maxPerCall !== undefined && amountMicro > maxPerCall) {
        return abort("price_cap_exceeded");
      }
    }

    const recordedAt = now();
    if (hourlyCap !== undefined && amountMicro !== undefined) {
      const cutoff = recordedAt - HOUR_MS;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].at <= cutoff) entries.splice(i, 1);
      }
      const spent = entries.reduce((sum, entry) => sum + entry.micro, 0n);
      if (spent + pendingMicro + amountMicro > hourlyCap) {
        return abort("hourly_budget_exceeded");
      }
      // No await between the budget check and reservation: concurrent requests
      // in this process see the reservation before entering the TWZRD hook.
      pendingMicro += amountMicro;
    }

    let reservation = hourlyCap !== undefined && amountMicro !== undefined;
    try {
      // Match installTwzrdAutoGate's switch semantics: disabling TWZRD's
      // reputation evaluation never disables these local hard spend controls.
      if (!isTwzrdAutoGateDisabled(options.twzrd)) {
        const result = await twzrdHook(context);
        if (result?.abort) return result;
      }

      if (hourlyCap !== undefined && amountMicro !== undefined) {
        entries.push({ at: recordedAt, micro: amountMicro });
      }
      return undefined;
    } finally {
      if (reservation && amountMicro !== undefined) {
        pendingMicro -= amountMicro;
        reservation = false;
      }
    }
  };

  // The outcome ledger brackets the checks: begin() before them, refuse() on
  // an abort, markSigning() (durable) when they pass and before the scheme
  // signs. An unresolved earlier attempt on the same intent aborts here.
  const guardedHook = async (
    context: BeforePaymentCreationContext,
  ): Promise<BeforePaymentCreationResult> => {
    if (!outcome) return innerHook(context);
    const opened = outcome.open(context);
    if (opened && "abort" in opened) return abort(opened.abort);
    const result = await innerHook(context);
    return opened ? outcome.close(opened.intentHash, result) : result;
  };

  // Register our composite hook once. It applies local limits first, then the
  // same official x402 pre-sign evaluator used by AutoGate 0.9.13.
  options.client.onBeforePaymentCreation(guardedHook);
  guardedClients.add(options.client as object);

  let payingFetch: typeof fetch | undefined;
  let initializing: Promise<typeof fetch> | undefined;
  const getPayingFetch = (): Promise<typeof fetch> => {
    if (payingFetch) return Promise.resolve(payingFetch);
    if (!initializing) {
      initializing = import("@x402/fetch").then(
        ({ wrapFetchWithPayment }) => {
          payingFetch = wrapFetchWithPayment(fetchImpl, options.client as never);
          return payingFetch;
        },
        (cause: unknown) => {
          initializing = undefined;
          throw new Error(
            "[twzrd-x402-gate] createGuardedX402Fetch needs @x402/fetch, an optional peer dependency " +
              "npm does not install for you. Run: npm install @x402/fetch @x402/core and your scheme " +
              "package (@x402/svm for Solana, @x402/evm for Base).",
            { cause },
          );
        },
      );
    }
    return initializing;
  };

  return async (input, init) => {
    if (options.heldVaultSpend) {
      const verdict = decideHeldVaultSpend(options.heldVaultSpend);
      if (verdict.refused) {
        throw new Error(`[twzrd-guarded-fetch] ${verdict.reason}`);
      }
    }
    const paying = await getPayingFetch();
    try {
      return await paying(input, init);
    } catch (error) {
      throw explainCoreSpendControls(error);
    }
  };
}

const CORE_SPEND_CONTROLS_HINT =
  "[twzrd-x402-gate] @x402/core refused this payment with its own default spend controls " +
  "(recognized assets only, $1 per payment) before the TWZRD checks ran. To let " +
  "maxPricePerCall / hourlyBudgetCap / allowedRecipients govern instead, disable or widen core's " +
  "controls on the client you pass in: client.setSpendControls(false), or build it with " +
  "x402Client.fromConfig({ ..., spendControls: { maxAmountPerPayment: ..., allowedAssets: [...] } }). " +
  "Note: new x402Client({ spendControls: false }) does NOT disable them.";

/** Rewrap @x402/core's spend-control refusal so the caller learns how to fix it. */
export function explainCoreSpendControls(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!/spendControls/.test(message)) return error;
  return new Error(`${CORE_SPEND_CONTROLS_HINT} Original: ${message}`, { cause: error });
}
