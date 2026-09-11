/**
 * V7-capable receipt verification for the Eliza plugin.
 *
 * `@wzrd_sol/sdk` (through 0.4.8) only knows V5/V6 leaf bindings and defaults
 * to the legacy v1 signing key. Current paid trust issues V7 receipts that bind
 * freshness into the leaf and are signed with twzrd-receipt-ed25519-v2.
 *
 * This module routes through `twzrd-receipt-verifier@^1.4.0` and labels V6
 * results with the downgraded freshness status from docs/receipt-v6-spec.md.
 */
import { createRequire } from 'node:module';

export const REPUTATION_V5_DOMAIN = 'TWZRD:AO_REPUTATION_RECEIPT_V5';
export const REPUTATION_V6_DOMAIN = 'TWZRD:AO_REPUTATION_RECEIPT_V6';
export const REPUTATION_V7_DOMAIN = 'TWZRD:AO_REPUTATION_RECEIPT_V7';
export const CURRENT_RECEIPT_PUBKEY = 'Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS';
export const CURRENT_RECEIPT_KEY_ID = 'twzrd-receipt-ed25519-v2';

export type ReceiptVersion = 'v7' | 'v6' | 'v5' | 'unknown';
/** V7 binds freshness. V6 freshness is advisory only. V5 also leaves provenance unsigned. */
export type FreshnessStatus = 'signed' | 'derived_from_timestamp' | 'unauthenticated';

export type TwzrdReceiptLike = {
  version?: string;
  kind?: string;
  leaf?: string;
  preimage?: Record<string, unknown>;
  signature?: string;
  signing_pubkey?: string;
  key_id?: string;
  signing_alg?: string;
  [k: string]: unknown;
};

export type VerifyReceiptResult = {
  valid: boolean;
  leafValid: boolean;
  signatureValid: boolean;
  trustedPubkey: string;
  errors: string[];
  receiptVersion: ReceiptVersion;
  freshness: FreshnessStatus;
  freshnessUnauthenticated: boolean;
  unauthenticatedFields: string[];
  recomputedLeaf?: string;
  boundFreshnessCard?: string;
  verifiedBy: 'twzrd-receipt-verifier';
};

type VerifierModule = {
  verify: (
    receipt: unknown,
    trustedPubkey: string,
    opts?: { maxAgeSeconds?: number; maxFutureSkewSeconds?: number },
  ) => {
    valid: boolean;
    leaf_valid: boolean;
    signature_valid: boolean;
    errors: string[];
    trusted_pubkey?: string;
    unauthenticated_fields?: string[];
    freshness_unauthenticated?: boolean;
    recomputed_leaf?: string;
  };
  CURRENT_RECEIPT_PUBKEY: string;
  formatBoundFreshnessCard: (receipt: unknown, res: unknown) => string;
};

let cachedVerifier: VerifierModule | null = null;

function loadVerifier(): VerifierModule {
  if (cachedVerifier) return cachedVerifier;
  const require = createRequire(import.meta.url);
  cachedVerifier = require('twzrd-receipt-verifier') as VerifierModule;
  return cachedVerifier;
}

export function classifyReceipt(receipt: TwzrdReceiptLike | null | undefined): ReceiptVersion {
  if (!receipt || typeof receipt !== 'object') return 'unknown';
  const domain = String(receipt.preimage?.domain ?? '');
  const version = String(receipt.version ?? receipt.preimage?.version ?? '').toLowerCase();
  const kind = String(receipt.kind ?? '');
  if (
    domain === REPUTATION_V7_DOMAIN ||
    version === 'v7' ||
    kind === 'twzrd_reputation_receipt_v7'
  ) {
    return 'v7';
  }
  if (domain.includes('_V6') || version === 'v6') return 'v6';
  if (domain.includes('_V5') || version === 'v5') return 'v5';
  return 'unknown';
}

export function freshnessStatusFor(version: ReceiptVersion): FreshnessStatus {
  if (version === 'v7') return 'signed';
  if (version === 'v6') return 'derived_from_timestamp';
  return 'unauthenticated';
}

export function describeReceiptSurface(receipt: TwzrdReceiptLike | null | undefined): {
  version: ReceiptVersion;
  freshness: FreshnessStatus;
  label: string;
  detail: string;
} {
  const version = classifyReceipt(receipt);
  const freshness = freshnessStatusFor(version);
  if (version === 'v7') {
    return {
      version,
      freshness,
      label: 'Receipt v7 (current surface)',
      detail:
        'Freshness: signed — V7 binds recheck_after_unix, staleness_days, and score_decay_model into the leaf.',
    };
  }
  if (version === 'v6') {
    return {
      version,
      freshness,
      label: 'Receipt v6 (legacy)',
      detail:
        'Freshness: derived_from_timestamp — recheck_after_unix, staleness_days, and score_decay_model are not leaf-bound. Enforce max_age_seconds against signed timestamp_unix (docs/receipt-v6-spec.md).',
    };
  }
  if (version === 'v5') {
    return {
      version,
      freshness,
      label: 'Receipt v5 (legacy)',
      detail:
        'Freshness: unauthenticated — V5 leaves provenance and freshness fields unsigned. Prefer a current V7 receipt.',
    };
  }
  return {
    version,
    freshness,
    label: 'Receipt unknown',
    detail: 'Could not classify receipt version from domain/kind/version.',
  };
}

export type VerifyReceiptOptions = {
  trustedPubkey?: string;
  maxAgeSeconds?: number;
};

/**
 * Offline-verify a V5, V6, or V7 receipt with twzrd-receipt-verifier.
 * Defaults to the current v2 issuer key. Does not use the SDK V5/V6 path.
 */
export function verifyReceipt(
  receipt: TwzrdReceiptLike,
  opts: VerifyReceiptOptions = {},
): VerifyReceiptResult {
  const version = classifyReceipt(receipt);
  const freshness = freshnessStatusFor(version);
  const trustedPubkey = opts.trustedPubkey ?? CURRENT_RECEIPT_PUBKEY;
  const verifier = loadVerifier();
  const raw = verifier.verify(receipt, trustedPubkey, {
    maxAgeSeconds: opts.maxAgeSeconds,
  });
  return {
    valid: !!raw.valid,
    leafValid: !!raw.leaf_valid,
    signatureValid: !!raw.signature_valid,
    trustedPubkey: raw.trusted_pubkey ?? trustedPubkey,
    errors: Array.isArray(raw.errors) ? raw.errors : [],
    receiptVersion: version,
    freshness,
    freshnessUnauthenticated: raw.freshness_unauthenticated ?? version !== 'v7',
    unauthenticatedFields: raw.unauthenticated_fields ?? [],
    recomputedLeaf: raw.recomputed_leaf,
    boundFreshnessCard: verifier.formatBoundFreshnessCard(receipt, raw),
    verifiedBy: 'twzrd-receipt-verifier',
  };
}

export function formatVerifyResult(result: VerifyReceiptResult): string {
  if (!result.valid) {
    const prefix =
      result.receiptVersion === 'v6'
        ? 'Receipt INVALID (legacy V6, freshness=derived_from_timestamp)'
        : result.receiptVersion === 'v7'
          ? 'Receipt INVALID (V7, freshness=signed)'
          : `Receipt INVALID (${result.receiptVersion}, freshness=${result.freshness})`;
    return `${prefix}: ${result.errors.join('; ') || 'unknown error'}`;
  }
  const lines = [
    `Receipt VALID (v${result.receiptVersion === 'unknown' ? '?' : result.receiptVersion.replace(/^v/, '')}, freshness=${result.freshness}, leaf=${result.leafValid}, sig=${result.signatureValid}, key=${result.trustedPubkey})`,
    `Verified by ${result.verifiedBy}@^1.4.0`,
  ];
  if (result.receiptVersion === 'v6') {
    lines.push(
      'Legacy V6: freshness fields are advisory only. Do not treat recheck_after_unix as a signed claim.',
    );
  }
  if (result.receiptVersion === 'v7') {
    lines.push('Current V7: freshness fields are covered by the signed leaf.');
  }
  if (result.boundFreshnessCard) lines.push(result.boundFreshnessCard);
  return lines.join('\n');
}
