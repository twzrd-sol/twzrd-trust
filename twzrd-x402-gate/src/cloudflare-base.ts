/**
 * Edge-safe Base x402 preflight gate.
 *
 * This module is intentionally standalone: it imports no package code and uses
 * only Fetch/Web-standard APIs, so Workers can import `twzrd-x402-gate/cloudflare-base`
 * without bringing Node modules or Solana adapters into their bundle.
 */

export const BASE_CHAIN_ID = 8453;
export const BASE_NETWORK = `eip155:${BASE_CHAIN_ID}`;

export type CloudflareBaseRequirements = {
  resource?: string;
  accepts?: Array<Record<string, unknown>>;
};

export type BasePreflightVerdict = {
  decision: "allow" | "warn" | "block";
  /** TWZRD's current preflight calls this trust_score; normalized here for callers. */
  riskScore: number | null;
  reasons: string[];
};

export type CloudflareBaseGateOptions = {
  intelBase?: string;
  fetch?: typeof fetch;
  /** Explicit price context only; x402 atomic amounts are never treated as USD. */
  priceUsdc?: number;
  resourceName?: string;
  agentIntent?: string;
  /** Default false: an unavailable or malformed preflight does not permit signing. */
  failOpen?: boolean;
};

export class TwzrdBasePaymentBlockedError extends Error {
  readonly verdict: BasePreflightVerdict;

  constructor(verdict: BasePreflightVerdict) {
    super(`[twzrd] Base payment blocked: ${verdict.reasons.join(",") || "PREFLIGHT_BLOCK"}`);
    this.name = "TwzrdBasePaymentBlockedError";
    this.verdict = verdict;
  }
}

/**
 * Calls the live TWZRD preflight with an exact Base mainnet payTo.
 *
 * Both lowercase and checksummed EVM addresses are valid inputs. The address is
 * preserved as received; the endpoint evaluates the exact recipient the client
 * is about to authorize.
 */
export async function twzrdBasePreflight(
  requirements: CloudflareBaseRequirements,
  options: CloudflareBaseGateOptions = {},
): Promise<BasePreflightVerdict> {
  const payTo = basePayTo(requirements);
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("[twzrd] Worker fetch is unavailable");

  const intelBase = (options.intelBase ?? "https://intel.twzrd.xyz").replace(/\/+$/, "");
  const response = await fetchFn(`${intelBase}/v1/intel/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resource_name: options.resourceName ?? requirements.resource ?? "cloudflare_base_x402",
      resource_url: requirements.resource,
      seller_wallet: payTo,
      price_usdc: options.priceUsdc,
      agent_intent: options.agentIntent ?? "cloudflare_base_x402_preflight",
      chain: "base",
      chain_id: BASE_CHAIN_ID,
    }),
  });
  if (!response.ok) throw new Error(`[twzrd] Base preflight HTTP ${response.status}`);
  return normalizePreflight(await response.json());
}

/** Cloudflare `withX402Client` callback: true permits the retry; false aborts it. */
export function createTwzrdCloudflareBaseApproval(
  options: CloudflareBaseGateOptions = {},
): (requirements: CloudflareBaseRequirements) => Promise<boolean> {
  return async (requirements) => {
    try {
      return (await twzrdBasePreflight(requirements, options)).decision !== "block";
    } catch {
      return options.failOpen === true;
    }
  };
}

/**
 * Minimal signing interceptor for a Worker or Viem account. The callback is
 * invoked only after the exact Base payTo received a non-block verdict.
 */
export async function withTwzrdBasePreflight<T>(
  requirements: CloudflareBaseRequirements,
  options: CloudflareBaseGateOptions,
  signOrSend: () => Promise<T>,
): Promise<T> {
  let verdict: BasePreflightVerdict;
  try {
    verdict = await twzrdBasePreflight(requirements, options);
  } catch (error) {
    if (options.failOpen === true) return signOrSend();
    throw error;
  }
  if (verdict.decision === "block") throw new TwzrdBasePaymentBlockedError(verdict);
  return signOrSend();
}

function basePayTo(requirements: CloudflareBaseRequirements): string {
  const accept = requirements.accepts?.find((candidate) => {
    const network = candidate.network;
    const chainId = candidate.chainId ?? candidate.chain_id;
    return network === BASE_NETWORK || chainId === BASE_CHAIN_ID || chainId === String(BASE_CHAIN_ID);
  });
  const payTo = accept?.payTo ?? accept?.pay_to;
  if (typeof payTo !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
    throw new Error("[twzrd] Base x402 requirements lack a valid eip155:8453 payTo");
  }
  return payTo;
}

function normalizePreflight(value: unknown): BasePreflightVerdict {
  const response = asRecord(value);
  if (!response) throw new Error("[twzrd] Base preflight returned a non-object response");
  const card = asRecord(response.readiness_card) ?? response;
  const decision = card.decision;
  if (decision !== "allow" && decision !== "warn" && decision !== "block") {
    throw new Error("[twzrd] Base preflight returned no valid decision");
  }
  const riskScore = numberOrNull(card.risk_score) ?? numberOrNull(card.trust_score);
  const reasons = strings(card.reasons ?? card.reason_codes ?? asRecord(card.decision_envelope)?.reason_codes);
  return { decision, riskScore, reasons };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
