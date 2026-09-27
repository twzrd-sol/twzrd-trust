import { isTwzrdAutoGateDisabled } from "./auto-gate.js";
import { toMicroUsd } from "./intent.js";
import { resolveRequirementFields } from "./payto.js";
import {
  createTwzrdPayKitBeforePaymentHook,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type InstallX402ClientHookOptions,
  type X402ClientLike,
} from "./x402-client-hook.js";

const HOUR_MS = 60 * 60 * 1000;
const guardedClients = new WeakSet<object>();
const USDC_ASSETS: Record<string, ReadonlySet<string>> = {
  solana: new Set([
    "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v", // mainnet USDC
    "gh9zwemdlj8dsckntktqpbnwlnnbjuszag9vp2kgtkjr", // devnet USDC
  ]),
  "eip155:8453": new Set([
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base USDC
  ]),
  "eip155:84532": new Set([
    "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // Base Sepolia test USDC
  ]),
};

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

function isUsdcRequirement(requirement: Record<string, unknown>): boolean {
  const network = String(requirement.network ?? "").toLowerCase();
  const asset = String(requirement.asset ?? "").toLowerCase();
  if (network === "solana" || network.startsWith("solana:")) {
    return USDC_ASSETS.solana.has(asset);
  }
  if (network === "base" || network === "base-mainnet" || network === "eip155:8453") {
    return USDC_ASSETS["eip155:8453"].has(asset);
  }
  if (network === "base-sepolia" || network === "eip155:84532") {
    return USDC_ASSETS["eip155:84532"].has(asset);
  }
  return false;
}

function abort(reason: string): BeforePaymentCreationResult {
  return { abort: true, reason: `[twzrd-guarded-fetch] ${reason}` };
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
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const entries: SpendEntry[] = [];
  let pendingMicro = 0n;
  const twzrdHook = createTwzrdPayKitBeforePaymentHook(options.twzrd);

  const guardedHook = async (
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

  // Register our composite hook once. It applies local limits first, then the
  // same official x402 pre-sign evaluator used by AutoGate 0.9.13.
  options.client.onBeforePaymentCreation(guardedHook);
  guardedClients.add(options.client as object);

  let payingFetch: typeof fetch | undefined;
  let initializing: Promise<typeof fetch> | undefined;
  const getPayingFetch = (): Promise<typeof fetch> => {
    if (payingFetch) return Promise.resolve(payingFetch);
    if (!initializing) {
      initializing = import("@x402/fetch").then(({ wrapFetchWithPayment }) => {
        payingFetch = wrapFetchWithPayment(fetchImpl, options.client as never);
        return payingFetch;
      });
    }
    return initializing;
  };

  return async (input, init) => (await getPayingFetch())(input, init);
}
