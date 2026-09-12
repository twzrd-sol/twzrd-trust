/**
 * Source-side V7 receipt tests. Uses the official signed example from
 * GET /v1/receipts/example and the plugin verifier wrapper — not mirrored dist.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TRUSTED_RECEIPT_PUBKEY, verifyReceipt as verifyReceiptSdk } from '@wzrd_sol/sdk';
import {
  classifyReceipt,
  describeReceiptSurface,
  freshnessFromVerify,
  freshnessStatusFor,
  verifyReceipt,
  type TwzrdReceiptLike,
} from '../src/receipt-verify.js';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const v7Example = JSON.parse(
  readFileSync(join(fixtureDir, 'fixtures/receipt-v7.example.json'), 'utf8'),
) as TwzrdReceiptLike;

const v6Unsigned: TwzrdReceiptLike = {
  version: 'v6',
  leaf: '0x4c82649d2be393b1fca2da7c5d4c7afebb189ad3f0b93b620ce2e552fe5ce558',
  preimage: {
    domain: 'TWZRD:AO_REPUTATION_RECEIPT_V6',
    agent_id: '11111111111111111111111111111111',
    score: 72,
    confidence_bps: 8000,
    timestamp_unix: 1748736000,
    payer: '11111111111111111111111111111111',
    settlement_tx: 'EXAMPLE-sample-receipt-no-real-settlement-tx-0001',
    reputation_score: 4242,
    reputation_confidence_bps: 7500,
    reputation_score_version: 'intel_renorm_v1',
    reputation_feature_window_start_unix: 1748000000,
    reputation_data_quality: 'high',
    recheck_after_unix: 1748995200,
    staleness_days: 3,
    score_decay_model: 'step:<=7d=1.0,<=30d=0.8,<=90d=0.5,>90d=0.25',
    version: 'v6',
  },
  signature: 'sig',
  signing_pubkey: '11111111111111111111111111111111',
};

describe('V7 receipt surface (source)', () => {
  it('classifies the official example as V7 with signed freshness', () => {
    assert.equal(classifyReceipt(v7Example), 'v7');
    assert.equal(freshnessStatusFor('v7'), 'signed');
    const surface = describeReceiptSurface(v7Example);
    assert.equal(surface.version, 'v7');
    assert.equal(surface.freshness, 'signed');
    assert.match(surface.label, /v7/i);
    assert.match(surface.detail, /signed/i);
  });

  it('verifies the official V7 example with twzrd-receipt-verifier', () => {
    const result = verifyReceipt(v7Example);
    assert.equal(result.verifiedBy, 'twzrd-receipt-verifier');
    assert.equal(result.receiptVersion, 'v7');
    assert.equal(result.freshness, 'signed');
    assert.equal(result.freshnessUnauthenticated, false);
    assert.deepEqual(result.unauthenticatedFields, []);
    assert.equal(result.leafValid, true, result.errors.join('; '));
    assert.equal(result.signatureValid, true, result.errors.join('; '));
    assert.equal(result.valid, true, result.errors.join('; '));
    assert.match(result.boundFreshnessCard ?? '', /covered by the V7 leaf binding/);
  });

  it('rejects a tampered V7 score (leaf no longer matches)', () => {
    const tampered = structuredClone(v7Example);
    tampered.preimage = { ...tampered.preimage, score: 99 };
    const result = verifyReceipt(tampered);
    assert.equal(result.receiptVersion, 'v7');
    assert.equal(result.valid, false);
    assert.equal(result.leafValid, false);
  });

  it('labels legacy V6 as freshness=derived_from_timestamp', () => {
    assert.equal(classifyReceipt(v6Unsigned), 'v6');
    const surface = describeReceiptSurface(v6Unsigned);
    assert.equal(surface.freshness, 'derived_from_timestamp');
    assert.match(surface.label, /legacy/i);
    const result = verifyReceipt(v6Unsigned);
    assert.equal(result.receiptVersion, 'v6');
    assert.equal(result.freshness, 'derived_from_timestamp');
    assert.equal(result.freshnessUnauthenticated, true);
    assert.ok(result.unauthenticatedFields.includes('recheck_after_unix'));
    assert.equal(result.valid, false);
  });

  it('SDK verifyReceipt does not implement the V7 leaf (why this package uses the verifier)', async () => {
    const sdk = await verifyReceiptSdk(v7Example as never);
    assert.notEqual(
      (sdk as { leafVersion?: string }).leafVersion,
      'v7',
      'SDK 0.4.8 still reports only v5/v6 leaf versions',
    );
    assert.equal(sdk.valid, false);
  });

  it('does not treat envelope version/kind as V7 when the domain is V6', () => {
    const spoofed: TwzrdReceiptLike = {
      ...v6Unsigned,
      version: 'v7',
      kind: 'twzrd_reputation_receipt_v7',
      preimage: { ...v6Unsigned.preimage, version: 'v7' },
    };
    assert.equal(classifyReceipt(spoofed), 'v6');
    const surface = describeReceiptSurface(spoofed);
    assert.equal(surface.freshness, 'derived_from_timestamp');
    const result = verifyReceipt(spoofed);
    assert.equal(result.receiptVersion, 'v6');
    assert.equal(result.freshness, 'derived_from_timestamp');
    assert.notEqual(result.freshness, 'signed');
    assert.equal(result.valid, false);
  });

  it('V7 kind/version mismatch is INVALID and must not report freshness=signed', () => {
    const mismatched = structuredClone(v7Example);
    mismatched.kind = 'twzrd_reputation_receipt_v6';
    const result = verifyReceipt(mismatched);
    assert.equal(result.receiptVersion, 'v7');
    assert.equal(result.valid, false);
    assert.equal(result.freshnessUnauthenticated, true);
    assert.equal(result.freshness, 'unauthenticated');
    assert.equal(freshnessFromVerify(result), 'unauthenticated');
  });

  it('maxAgeSeconds rejects the official V7 example (timestamp is not current)', () => {
    const result = verifyReceipt(v7Example, { maxAgeSeconds: 86400 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.equal(result.freshness, 'unauthenticated');
  });

  it('freshnessFromVerify is signed only for valid authenticated V7', () => {
    assert.equal(
      freshnessFromVerify({ valid: true, freshnessUnauthenticated: false, receiptVersion: 'v7' }),
      'signed',
    );
    assert.equal(
      freshnessFromVerify({ valid: true, freshnessUnauthenticated: true, receiptVersion: 'v7' }),
      'unauthenticated',
    );
    assert.equal(
      freshnessFromVerify({ valid: false, freshnessUnauthenticated: false, receiptVersion: 'v7' }),
      'unauthenticated',
    );
    assert.equal(
      freshnessFromVerify({ valid: false, freshnessUnauthenticated: true, receiptVersion: 'v6' }),
      'derived_from_timestamp',
    );
  });

  it('SDK v1 TRUSTED_RECEIPT_PUBKEY fail-closes the official V7 example', () => {
    const result = verifyReceipt(v7Example, { trustedPubkey: TRUSTED_RECEIPT_PUBKEY });
    assert.equal(result.valid, false);
    assert.equal(result.freshness, 'unauthenticated');
  });
});
