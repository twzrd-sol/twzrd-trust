/**
 * Chain-neutral network classification for Path E.
 *
 * Reputation is scored per corpus, never inferred across chains. Two corpora
 * exist today: Solana, and Base via `twzrd-x402-base-corpus` (x402_base_daily,
 * built from high-confidence EIP-3009 USDC settlements). A network is scored
 * only when a corpus actually covers it.
 *
 * Every other network — Polygon, Arbitrum, Ethereum mainnet, testnets — stays
 * recognized but unscored. Never invent a reputation for them from Solana
 * history, Base history, or catalog metadata.
 */

export type NetworkKind = "solana" | "evm" | "other" | "unknown";

/**
 * EVM networks TWZRD holds a behavioral corpus for. Base mainnet only: the
 * corpus is `x402_base_daily`, indexed from Base EIP-3009 USDC settlements,
 * and it says nothing about any other chain. Widening this list without a
 * corpus behind it would fabricate exactly the reputation this module exists
 * to refuse.
 */
export const SCORED_EVM_NETWORKS: ReadonlySet<string> = new Set(["eip155:8453"]);

/** Canonical CAIP-2 id for a scored EVM alias, or undefined. */
export function canonicalEvmNetwork(n: string): string | undefined {
  const s = n.trim().toLowerCase();
  if (s === "base" || s === "base-mainnet" || s === "eip155:8453") return "eip155:8453";
  return undefined;
}

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
 * Scored today: Solana mainnet (and generic "solana" / mainnet markers), and
 * Base mainnet (eip155:8453 / "base"), which has its own corpus.
 * Recognized but unscored: every other eip155:* chain (Polygon, Arbitrum,
 * Ethereum) and all testnets.
 *
 * When `network` is omitted (legacy integrators), default to Solana scoring
 * unless `payTo` is a 0x EVM address. A bare EVM address is NOT assumed to be
 * Base: without an explicit network there is nothing to say which chain it is
 * on, so it stays unscored.
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

  // Base mainnet has its own corpus, so it is scored like Solana is.
  // Testnets are excluded: base-sepolia is recognized but has no corpus.
  const canonical =
    n.includes("sepolia") || n.includes("testnet") || n.includes("devnet")
      ? undefined
      : canonicalEvmNetwork(n);
  if (canonical && SCORED_EVM_NETWORKS.has(canonical)) {
    return {
      network: raw,
      kind: "evm",
      reputationScored: true,
      networkSupported: true,
      reason: "base_scored",
    };
  }

  // Every other EVM chain and alias: recognized, no corpus, never scored.
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
 * - observe (default): allow payment but never claim reputation approval.
 *   Callers that refuse wash_flagged must still run merchant_card after this
 *   (see twzrdApprovePayment) — observe is not a wash bypass.
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
