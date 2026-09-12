/**
 * Source-side Eliza registration + V7 receipt handling.
 * Imports the TypeScript plugin directly (not eliza-plugin/dist).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '@elizaos/core';
import type { Content, IAgentRuntime, Memory } from '@elizaos/core';
import wzrdPlugin, {
  createWzrdPlugin,
  wzrdPluginWithLegacyEarn,
  intelPreflightAction,
  merchantCardAction,
  intelTrustAction,
  verifyReceiptAction,
  setPayingFetch,
  clearPayingFetch,
  getIntelClient,
  resolvePayingFetch,
} from '../src/index.js';
import type { TwzrdReceiptLike } from '../src/receipt-verify.js';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const v7Example = JSON.parse(
  readFileSync(join(fixtureDir, 'fixtures/receipt-v7.example.json'), 'utf8'),
) as TwzrdReceiptLike;

const SELLER = '4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE';

function mockMemory(content: Record<string, unknown>): Memory {
  return {
    id: '00000000-0000-0000-0000-000000000001' as Memory['id'],
    entityId: '00000000-0000-0000-0000-000000000002' as Memory['entityId'],
    roomId: '00000000-0000-0000-0000-000000000003' as Memory['roomId'],
    content: content as Memory['content'],
    createdAt: Date.now(),
  };
}

function mockRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  const store = new Map<string, string | boolean | number | null>(Object.entries(settings));
  return {
    getSetting: (key: string) => store.get(key) ?? null,
    getService: () => null,
    fetch: globalThis.fetch,
  } as unknown as IAgentRuntime;
}

function allowGateFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/merchant_card/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ merchant: SELLER, wash_flagged: false }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        readiness_card: { version: '1', decision: 'allow', trust_score: 80, can_spend: true },
        reason: 'preflight decision=allow',
      }),
    } as Response;
  }) as typeof fetch;
}

describe('wzrdPlugin intel registration + V7 receipt handling (source)', () => {
  after(() => {
    clearPayingFetch();
    // restore fetch if a test left a stub
  });

  it('createWzrdPlugin registers intel actions including merchant_card', () => {
    const names = createWzrdPlugin().actions?.map((a) => a.name) ?? [];
    for (const expected of [
      'WZRD_INTEL_PREFLIGHT',
      'WZRD_MERCHANT_CARD',
      'WZRD_INTEL_TRUST',
      'WZRD_VERIFY_RECEIPT',
    ]) {
      assert.ok(names.includes(expected), `${expected} must be registered`);
    }
  });

  it('default plugin (0.6+) does not register legacy earn actions', () => {
    const names = wzrdPlugin.actions?.map((a) => a.name) ?? [];
    for (const legacy of ['WZRD_INFER', 'WZRD_REPORT', 'WZRD_EARN', 'WZRD_CLAIM', 'WZRD_REWARDS']) {
      assert.equal(names.includes(legacy), false, `${legacy} must be opt-in`);
    }
  });

  it('createWzrdPlugin({ legacyEarnActions: true }) registers earn actions', () => {
    const names = createWzrdPlugin({ legacyEarnActions: true }).actions?.map((a) => a.name) ?? [];
    for (const legacy of ['WZRD_INFER', 'WZRD_REPORT', 'WZRD_EARN', 'WZRD_CLAIM', 'WZRD_REWARDS']) {
      assert.ok(names.includes(legacy), `${legacy} must register when legacyEarnActions is true`);
    }
  });

  it('wzrdPluginWithLegacyEarn matches createWzrdPlugin legacy opt-in', () => {
    assert.deepEqual(
      wzrdPluginWithLegacyEarn.actions?.map((a) => a.name),
      createWzrdPlugin({ legacyEarnActions: true }).actions?.map((a) => a.name),
    );
  });

  it('registers intel actions on a real @elizaos/core AgentRuntime', async () => {
    const runtime = new AgentRuntime({
      character: { name: 'wzrd-intel-test', bio: 'test', plugins: [] },
      settings: { WZRD_INTEL_URL: 'https://intel.twzrd.xyz' },
    });
    await runtime.registerPlugin(wzrdPlugin);
    const names = runtime.actions.map((a) => a.name);
    assert.ok(names.includes('WZRD_INTEL_PREFLIGHT'));
    assert.ok(names.includes('WZRD_MERCHANT_CARD'));
    assert.ok(names.includes('WZRD_INTEL_TRUST'));
    assert.ok(names.includes('WZRD_VERIFY_RECEIPT'));
    assert.match(wzrdPlugin.description ?? '', /V7/);
  });

  it('preflight handler accepts seller_wallet + price + resource_name (mocked)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        readiness_card: {
          version: '1',
          decision: 'ALLOW',
          trust_score: 72,
          can_spend: true,
        },
        preflight_id: 'pf_test',
      }),
    })) as unknown as typeof fetch;
    try {
      const callbacks: string[] = [];
      const result = await intelPreflightAction.handler!(
        mockRuntime({ WZRD_INTEL_URL: 'https://intel.twzrd.xyz' }),
        mockMemory({ seller_wallet: SELLER, price_usdc: 0.05, resource_name: 'test-resource' }),
        undefined,
        undefined,
        async (r: Content) => {
          callbacks.push(r.text ?? '');
          return [];
        },
      );
      assert.equal(result?.success, true, `preflight failed: ${String((result as { error?: string })?.error)}`);
      assert.match(callbacks.join('\n'), /Decision: (ALLOW|WARN|BLOCK)/i);
      assert.match(callbacks.join('\n'), /score|trust_score/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('preflight validation rejects bad seller_wallet (non-base58)', async () => {
    const callbacks: string[] = [];
    const result = await intelPreflightAction.handler!(
      mockRuntime(),
      mockMemory({ seller_wallet: 'not-base58!!!', price_usdc: 0.05 }),
      undefined,
      undefined,
      async (r: Content) => {
        callbacks.push(r.text ?? '');
        return [];
      },
    );
    assert.equal(result?.success, false);
    assert.match(callbacks.join('\n'), /Invalid preflight input/);
    assert.match(callbacks.join('\n'), /seller_wallet must be 32-44 char base58/);
  });

  it('paid trust with injected paying fetch surfaces a V7 receipt and signed freshness', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = allowGateFetch();
    setPayingFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pubkey: SELLER,
        trust: { score: 88 },
        paid: true,
        twzrd_receipt: v7Example,
      }),
    }) as Response);
    try {
      const callbacks: string[] = [];
      const result = await intelTrustAction.handler!(
        mockRuntime(),
        mockMemory({ pubkey: SELLER }),
        undefined,
        undefined,
        async (r: Content) => {
          callbacks.push(r.text ?? '');
          return [];
        },
      );
      assert.equal(result?.success, true, String((result as { error?: string })?.error));
      const text = callbacks.join('\n');
      assert.match(text, /Score: 88/);
      assert.match(text, /Receipt v7 \(current surface\)/);
      assert.match(text, /Offline verify: VALID/);
      assert.match(text, /freshness=signed/);
      assert.equal((result as { data?: { receipt_surface?: string; freshness?: string; receipt_valid?: boolean } }).data?.receipt_surface, 'v7');
      assert.equal((result as { data?: { freshness?: string } }).data?.freshness, 'signed');
      assert.equal((result as { data?: { receipt_valid?: boolean } }).data?.receipt_valid, true);
    } finally {
      globalThis.fetch = realFetch;
      clearPayingFetch();
    }
  });

  it('paid trust does not label a V6 body as signed freshness just because version/kind say v7', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = allowGateFetch();
    const spoofed = {
      version: 'v7',
      kind: 'twzrd_reputation_receipt_v7',
      leaf: '0x4c82649d2be393b1fca2da7c5d4c7afebb189ad3f0b93b620ce2e552fe5ce558',
      preimage: {
        domain: 'TWZRD:AO_REPUTATION_RECEIPT_V6',
        agent_id: '11111111111111111111111111111111',
        score: 72,
        version: 'v7',
      },
      signature: 'sig',
      signing_pubkey: '11111111111111111111111111111111',
    };
    setPayingFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pubkey: SELLER,
        trust: { score: 88 },
        paid: true,
        twzrd_receipt: spoofed,
      }),
    }) as Response);
    try {
      const callbacks: string[] = [];
      const result = await intelTrustAction.handler!(
        mockRuntime(),
        mockMemory({ pubkey: SELLER }),
        undefined,
        undefined,
        async (r: Content) => {
          callbacks.push(r.text ?? '');
          return [];
        },
      );
      assert.equal(result?.success, true);
      const data = (result as { data?: { receipt_surface?: string; freshness?: string; receipt_valid?: boolean } }).data;
      assert.equal(data?.receipt_surface, 'v6');
      assert.equal(data?.freshness, 'derived_from_timestamp');
      assert.equal(data?.receipt_valid, false);
      assert.doesNotMatch(callbacks.join('\n'), /freshness=signed/);
    } finally {
      globalThis.fetch = realFetch;
      clearPayingFetch();
    }
  });

  it('PREFLIGHT-BEFORE-PAY: decision=block aborts before any payment', async () => {
    const realFetch = globalThis.fetch;
    let payAttempted = false;
    setPayingFetch(async () => {
      payAttempted = true;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/merchant_card/')) {
        return { ok: true, status: 200, json: async () => ({ wash_flagged: false }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          readiness_card: { decision: 'block', trust_score: 5, can_spend: false },
          reason: 'seller flagged by corpus',
        }),
      } as Response;
    }) as typeof fetch;
    try {
      const callbacks: string[] = [];
      const result = await intelTrustAction.handler!(
        mockRuntime(),
        mockMemory({ pubkey: SELLER }),
        undefined,
        undefined,
        async (r: Content) => {
          callbacks.push(r.text ?? '');
          return [];
        },
      );
      assert.equal(result?.success, false);
      assert.equal((result as { error?: string }).error, 'preflight_block');
      assert.equal(payAttempted, false, 'payment must NOT be attempted after a block decision');
      assert.match(callbacks.join('\n'), /blocked|No payment was sent/i);
    } finally {
      globalThis.fetch = realFetch;
      clearPayingFetch();
    }
  });

  it('WASH REFUSE: wash_flagged aborts trust purchase even when preflight allows', async () => {
    const realFetch = globalThis.fetch;
    let payAttempted = false;
    setPayingFetch(async () => {
      payAttempted = true;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/merchant_card/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ merchant: SELLER, wash_flagged: true, wash_label: 'fleet_dominated' }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          readiness_card: { decision: 'allow', trust_score: 80, can_spend: true },
          reason: 'preflight decision=allow',
        }),
      } as Response;
    }) as typeof fetch;
    try {
      const callbacks: string[] = [];
      const result = await intelTrustAction.handler!(
        mockRuntime(),
        mockMemory({ pubkey: SELLER }),
        undefined,
        undefined,
        async (r: Content) => {
          callbacks.push(r.text ?? '');
          return [];
        },
      );
      assert.equal(result?.success, false);
      assert.equal((result as { error?: string }).error, 'wash_flagged');
      assert.equal(payAttempted, false);
      assert.match(callbacks.join('\n'), /wash|No payment was sent/i);
    } finally {
      globalThis.fetch = realFetch;
      clearPayingFetch();
    }
  });

  it('merchant card handler returns wash / catalog fields (mocked)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        merchant: SELLER,
        in_corpus: true,
        wash_flagged: false,
        wash_label: 'provider_organic_broad',
        catalog_enriched: false,
        offering_status: 'Offering unknown — graph only',
        unique_payers_90d: 12,
      }),
    })) as unknown as typeof fetch;
    try {
      const callbacks: string[] = [];
      const result = await merchantCardAction.handler!(
        mockRuntime(),
        mockMemory({ pubkey: SELLER }),
        undefined,
        undefined,
        async (r: Content) => {
          callbacks.push(r.text ?? '');
          return [];
        },
      );
      assert.equal(result?.success, true);
      assert.match(callbacks.join('\n'), /Wash flagged: no/i);
      assert.match(callbacks.join('\n'), /graph only/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('VERIFY: official V7 example is INVALID when max_age_seconds is 86400', async () => {
    const callbacks: string[] = [];
    const result = await verifyReceiptAction.handler!(
      mockRuntime(),
      mockMemory({ receipt: v7Example, max_age_seconds: 86400 }),
      undefined,
      undefined,
      async (r: Content) => {
        callbacks.push(r.text ?? '');
        return [];
      },
    );
    assert.equal(result?.success, false);
    assert.equal((result as { data?: { freshness?: string } }).data?.freshness, 'unauthenticated');
    assert.match(callbacks.join('\n'), /INVALID/);
    assert.doesNotMatch(callbacks.join('\n'), /freshness=signed/);
  });

  it('VERIFY: official V7 example is VALID with freshness=signed', async () => {
    const callbacks: string[] = [];
    const result = await verifyReceiptAction.handler!(
      mockRuntime(),
      mockMemory({ receipt: v7Example }),
      undefined,
      undefined,
      async (r: Content) => {
        callbacks.push(r.text ?? '');
        return [];
      },
    );
    assert.equal(result?.success, true, String((result as { error?: string })?.error));
    const text = callbacks.join('\n');
    assert.match(text, /VALID/);
    assert.match(text, /freshness=signed/);
    assert.match(text, /twzrd-receipt-verifier/);
    const data = (result as { data?: { receiptVersion?: string; freshness?: string } }).data;
    assert.equal(data?.receiptVersion, 'v7');
    assert.equal(data?.freshness, 'signed');
  });

  it('VERIFY: legacy V6 path reports freshness=derived_from_timestamp', async () => {
    const v6Receipt = {
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
        recheck_after_unix: 1748995200,
        staleness_days: 3,
        score_decay_model: 'step:<=7d=1.0,<=30d=0.8,<=90d=0.5,>90d=0.25',
        version: 'v6',
      },
      signature: 'sig',
      signing_pubkey: '11111111111111111111111111111111',
    };
    const callbacks: string[] = [];
    const result = await verifyReceiptAction.handler!(
      mockRuntime(),
      mockMemory({ receipt: v6Receipt }),
      undefined,
      undefined,
      async (r: Content) => {
        callbacks.push(r.text ?? '');
        return [];
      },
    );
    assert.ok(result);
    assert.equal((result as { data?: { receiptVersion?: string } }).data?.receiptVersion, 'v6');
    assert.equal((result as { data?: { freshness?: string } }).data?.freshness, 'derived_from_timestamp');
    assert.match(callbacks.join('\n'), /derived_from_timestamp|legacy V6/i);
  });

  it('trust surfaces payment_required on 402 from paying fetch', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = allowGateFetch();
    setPayingFetch(async () => ({
      ok: false,
      status: 402,
      headers: { get: () => null },
      json: async () => ({ error: 'payment required' }),
      text: async () => '',
    }) as unknown as Response);
    try {
      const callbacks: string[] = [];
      const result = await intelTrustAction.handler!(
        mockRuntime(),
        mockMemory({ pubkey: SELLER }),
        undefined,
        undefined,
        async (r: Content) => {
          callbacks.push(r.text ?? '');
          return [];
        },
      );
      assert.equal(result?.success, false);
      assert.equal((result as { error?: string }).error, 'payment_required');
      assert.match(callbacks.join('\n'), /x402|Intel trust requires|agentcash/i);
    } finally {
      globalThis.fetch = realFetch;
      clearPayingFetch();
    }
  });

  it('getIntelClient factory + resolvePayingFetch service fallback', () => {
    clearPayingFetch();
    const mockPaying = async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response;
    const rt = {
      getSetting: () => null,
      getService: (n: string) => (n === 'payingFetch' ? { fetch: mockPaying } : null),
      fetch: globalThis.fetch,
    } as unknown as IAgentRuntime;
    const intel = getIntelClient(rt);
    assert.equal(typeof intel.preflight, 'function');
    assert.equal(typeof intel.trust, 'function');
    assert.equal(typeof intel.verify, 'function');
    const v7 = intel.verify(v7Example);
    assert.equal(v7.receiptVersion, 'v7');
    assert.equal(v7.freshness, 'signed');
    assert.equal(v7.valid, true);
    assert.equal(resolvePayingFetch(rt), mockPaying);
  });
});
