/**
 * Receipt checks on a paid response: the V7 signature under the pinned
 * issuer key, and Merkle inclusion under the pinned log key.
 *
 * Keys are pinned in this package. Nothing here fetches a key, and there is
 * no fallback to a key a server names: a receipt signed by any other key is
 * invalid, whatever the response says about it.
 */
import { DEFAULT_STH_PUBKEY, verifyLogInclusion, verifyReceiptInLog } from "twzrd-log-verifier";
import { RECEIPT_ISSUER_PUBKEY, verifyReceiptBinding } from "twzrd-x402-gate";

export { RECEIPT_ISSUER_PUBKEY, DEFAULT_STH_PUBKEY };

export type ReceiptStatus = "verified" | "absent" | "invalid";
export type InclusionStatus = "proven" | "pending" | "failed" | "not_checked";

export interface ReceiptCheck {
  status: ReceiptStatus;
  version: "v6" | "v7" | null;
  /** 64 lowercase hex characters, when the receipt verified. */
  leaf: string | null;
  subject: string | null;
  detail: string;
}

export interface InclusionCheck {
  status: InclusionStatus;
  leafIndex: number | null;
  treeSize: number | null;
  detail: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Where a paid response keeps its data: the body itself, or an MCP tool result's `structuredContent`. */
function dataOf(body: unknown): Record<string, unknown>[] {
  if (!isObject(body)) return [];
  const result = isObject(body.result) ? body.result : undefined;
  const structured = result && isObject(result.structuredContent) ? result.structuredContent : undefined;
  return structured ? [body, structured] : [body];
}

/** The receipt a paid response carries, if any: `twzrd_receipt` (intel) or `receipt`. */
export function findReceipt(body: unknown): unknown {
  for (const doc of dataOf(body)) {
    if (doc.twzrd_receipt !== undefined) return doc.twzrd_receipt;
    if (doc.receipt !== undefined) return doc.receipt;
  }
  return undefined;
}

/** The inclusion proof a paid response carries, if any: `log_inclusion`. */
export function findInclusion(body: unknown): unknown {
  for (const doc of dataOf(body)) {
    if (doc.log_inclusion !== undefined) return doc.log_inclusion;
  }
  return undefined;
}

/** How far a receipt's signed timestamp may run ahead of this clock. */
export const RECEIPT_CLOCK_SKEW_SECONDS = 300;

/**
 * Verify a receipt offline. `subjects` are the wallets this call was about
 * (the recipient paid, and any wallet named in the request): a valid receipt
 * about some other wallet is a replay, and is refused.
 */
export function checkReceipt(
  receipt: unknown,
  opts: {
    subjects: readonly string[];
    requireV7: boolean;
    pinnedKeys?: readonly string[];
    /**
     * Oldest receipt accepted, in seconds, against the signed
     * `preimage.timestamp_unix`. Omitted or null: no age check.
     */
    maxAgeSeconds?: number | null;
    /** Milliseconds since the epoch. Default `Date.now()`. */
    now?: number;
    /** Leaves already accepted for earlier calls: a repeat is a replay. */
    seenLeaves?: ReadonlySet<string>;
  },
): ReceiptCheck {
  if (receipt === undefined || receipt === null) {
    return { status: "absent", version: null, leaf: null, subject: null, detail: "the response carries no receipt" };
  }
  const binding = verifyReceiptBinding(receipt, opts.pinnedKeys ?? [RECEIPT_ISSUER_PUBKEY]);
  if (!binding.ok) {
    return { status: "invalid", version: null, leaf: null, subject: null, detail: `the receipt does not verify under the pinned key: ${binding.error}` };
  }
  const preimage = isObject(receipt) && isObject(receipt.preimage) ? receipt.preimage : {};
  const subject = typeof preimage.agent_id === "string" ? preimage.agent_id : null;
  if (opts.requireV7 && binding.version !== "v7") {
    return { status: "invalid", version: binding.version, leaf: binding.leaf, subject, detail: `the receipt is ${binding.version}, and the mandate requires v7` };
  }
  if (subject === null || !opts.subjects.includes(subject)) {
    return {
      status: "invalid",
      version: binding.version,
      leaf: binding.leaf,
      subject,
      detail: "the receipt is about a wallet this call did not name",
    };
  }
  if (opts.maxAgeSeconds !== undefined && opts.maxAgeSeconds !== null) {
    const issued = preimage.timestamp_unix;
    const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
    if (typeof issued !== "number" || !Number.isFinite(issued)) {
      return { status: "invalid", version: binding.version, leaf: binding.leaf, subject, detail: "the receipt carries no signed timestamp, so its age cannot be checked" };
    }
    if (issued > nowSeconds + RECEIPT_CLOCK_SKEW_SECONDS) {
      return { status: "invalid", version: binding.version, leaf: binding.leaf, subject, detail: "the receipt is dated in the future" };
    }
    if (nowSeconds - issued > opts.maxAgeSeconds) {
      return {
        status: "invalid",
        version: binding.version,
        leaf: binding.leaf,
        subject,
        detail: `the receipt was issued ${nowSeconds - issued} s ago, older than the ${opts.maxAgeSeconds} s this runtime accepts`,
      };
    }
  }
  if (opts.seenLeaves?.has(binding.leaf)) {
    return { status: "invalid", version: binding.version, leaf: binding.leaf, subject, detail: "this receipt was already accepted for an earlier call" };
  }
  return { status: "verified", version: binding.version, leaf: binding.leaf, subject, detail: `verified under ${binding.pubkey}` };
}

/**
 * Prove the receipt's leaf is in the receipt log under the pinned log key.
 * An inclusion block carried in the response is checked offline. Without
 * one, the proof (never a key) is fetched from `logBaseUrl` when one is
 * configured.
 */
export async function checkInclusion(
  body: unknown,
  leaf: string,
  opts: { logBaseUrl?: string; fetchImpl?: typeof fetch; pinnedLogKey?: string },
): Promise<InclusionCheck> {
  const pinned = opts.pinnedLogKey ?? DEFAULT_STH_PUBKEY;
  const leafHex = leaf.startsWith("0x") ? leaf : `0x${leaf}`;
  const block = findInclusion(body);
  try {
    if (block !== undefined) {
      const result = verifyLogInclusion(block, pinned, { leaf: leafHex });
      return result.valid
        ? { status: "proven", leafIndex: result.leaf_index ?? null, treeSize: result.tree_size ?? null, detail: "inclusion proven offline under the pinned log key" }
        : { status: "failed", leafIndex: null, treeSize: null, detail: result.errors.join("; ") || "the inclusion proof does not verify" };
    }
    if (!opts.logBaseUrl) {
      return { status: "failed", leafIndex: null, treeSize: null, detail: "the response carries no inclusion proof and no log is configured" };
    }
    const result = await verifyReceiptInLog({
      baseUrl: opts.logBaseUrl,
      leaf: leafHex,
      trusted: pinned,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl as never } : {}),
    });
    if (result.valid && result.tofu !== true) {
      return { status: "proven", leafIndex: result.leaf_index ?? null, treeSize: result.tree_size ?? null, detail: "inclusion proven under the pinned log key" };
    }
    if (result.not_yet_merged === true) {
      return { status: "pending", leafIndex: null, treeSize: null, detail: "the log has not merged this receipt yet" };
    }
    return { status: "failed", leafIndex: null, treeSize: null, detail: result.errors.join("; ") || "the inclusion proof does not verify" };
  } catch (err) {
    return { status: "failed", leafIndex: null, treeSize: null, detail: `the inclusion check failed: ${(err as Error).message}` };
  }
}
