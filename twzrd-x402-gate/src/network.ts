/**
 * Chain-neutral network classification for Path E.
 *
 * Reputation scoring is Solana-deep today. Other networks are *recognized*
 * (we parse them) but not *scored*. Never invent a Base reputation from
 * Solana history or catalog metadata.
 */

export type NetworkKind = "solana" | "evm" | "other" | "unknown";

export type NetworkClass = {
  /** Raw network string from the payment requirement */
  network: string | undefined;
  kind: NetworkKind;
  /** True when TWZRD has behavioral reputation for this network */
  reputationScored: boolean;
  /** True when we recognize the CAIP-2 / x402 network identifier shape */
  networkSupported: boolean;
  reason: string;
};

/**
 * Classify an x402 `accepts[].network` value (optional payTo heuristic).
 *
 * Scored today: Solana mainnet (and generic "solana" / mainnet markers).
 * Recognized but unscored: eip155:* (Base, Polygon, Arbitrum, …).
 *
 * When `network` is omitted (legacy integrators), default to Solana scoring
 * unless `payTo` is a 0x EVM address — never invent Base reputation.
 */
export function classifyNetwork(
  network: string | undefined | null,
  payTo?: string | null,
): NetworkClass {
  const raw = network == null ? undefined : String(network).trim();
  if (!raw) {
    const pt = payTo == null ? "" : String(payTo).trim();
    // Explicit EVM payTo without network → unscored EVM
    if (/^0x[a-fA-F0-9]{40}$/.test(pt)) {
      return {
        network: undefined,
        kind: "evm",
        reputationScored: false,
        networkSupported: true,
        reason: "network_not_scored",
      };
    }
    // Legacy default: Solana product surface scores base58 / missing-network payments
    return {
      network: undefined,
      kind: "solana",
      reputationScored: true,
      networkSupported: true,
      reason: "solana_scored",
    };
  }
  const n = raw.toLowerCase();

  // Solana mainnet CAIP-2 genesis, bare "solana", or mainnet keyword.
  const isSolana =
    n.includes("solana") ||
    n.includes("5eykt4") || // mainnet genesis prefix in CAIP-2
    n === "solana:mainnet" ||
    n === "mainnet-beta";
  if (isSolana) {
    // Devnet/testnet: recognized, not scored (no production corpus).
    if (n.includes("devnet") || n.includes("testnet") || n.includes("localnet")) {
      return {
        network: raw,
        kind: "solana",
        reputationScored: false,
        networkSupported: true,
        reason: "network_not_scored",
      };
    }
    return {
      network: raw,
      kind: "solana",
      reputationScored: true,
      networkSupported: true,
      reason: "solana_scored",
    };
  }

  // EVM CAIP-2 and common aliases (Base, Polygon, Arbitrum, …).
  if (
    n.startsWith("eip155:") ||
    n === "base" ||
    n.includes("base-mainnet") ||
    n.includes("base-sepolia") ||
    n.includes("polygon") ||
    n.includes("arbitrum") ||
    n.includes("ethereum")
  ) {
    return {
      network: raw,
      kind: "evm",
      reputationScored: false,
      networkSupported: true,
      reason: "network_not_scored",
    };
  }

  return {
    network: raw,
    kind: "other",
    reputationScored: false,
    networkSupported: true,
    reason: "network_not_scored",
  };
}

/**
 * Policy action for an unscored (or unsupported) network.
 * - observe (default): allow payment but never claim reputation approval
 * - strict: block before signing
 */
export type UnsupportedNetworkMode = "observe" | "strict";

export type UnsupportedNetworkDecision = {
  /** Never "allow" from intelligence — only policy */
  decision: "unknown";
  reason: string;
  policyAction: "allow" | "block";
  approved: boolean;
  network: string | undefined;
  networkSupported: boolean;
  reputationScored: false;
  kind: NetworkKind;
};

export function decideUnsupportedNetwork(
  cls: NetworkClass,
  mode: UnsupportedNetworkMode,
): UnsupportedNetworkDecision {
  const policyAction = mode === "strict" ? "block" : "allow";
  return {
    decision: "unknown",
    reason: cls.reason === "network_missing" ? "network_missing" : "network_not_scored",
    policyAction,
    approved: policyAction === "allow",
    network: cls.network,
    networkSupported: cls.networkSupported,
    reputationScored: false,
    kind: cls.kind,
  };
}

/** Telemetry-safe log line (no secrets). */
export function logUnsupportedNetwork(event: {
  network?: string;
  payTo?: string;
  amountBucket?: string;
  policyMode: UnsupportedNetworkMode;
  policyAction: "allow" | "block";
  adapter?: string;
}): void {
  try {
    console.info(
      "[twzrd-x402-gate] unsupported_network_seen",
      JSON.stringify({
        event: "unsupported_network_seen",
        network: event.network ?? null,
        payTo_prefix: event.payTo ? String(event.payTo).slice(0, 8) : null,
        amount_bucket: event.amountBucket ?? null,
        policy_mode: event.policyMode,
        policy_action: event.policyAction,
        adapter: event.adapter ?? null,
      }),
    );
  } catch {
    // never throw from telemetry
  }
}

export function amountBucket(amountMicro: string | undefined): string {
  if (amountMicro == null || amountMicro === "") return "unknown";
  const n = Number(amountMicro);
  if (!Number.isFinite(n)) return "unknown";
  if (n <= 0) return "0";
  if (n < 1000) return "<0.001";
  if (n < 10_000) return "0.001-0.01";
  if (n < 50_000) return "0.01-0.05";
  if (n < 100_000) return "0.05-0.10";
  return ">=0.10";
}
