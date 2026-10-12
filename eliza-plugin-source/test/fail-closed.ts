/**
 * 0.8.0 adapter contract: merchant_card outage is fail-closed, paid trust needs a
 * spend confirmation and returns a zero-spend refuse packet, and the auto-gate
 * carries a default integration attribution.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Content, IAgentRuntime, Memory } from '@elizaos/core';
import {
  merchantCardAction,
  intelTrustAction,
  setPayingFetch,
  clearPayingFetch,
  autoGateOptions,
  refusePacket,
  paidLookupConfirmed,
} from '../src/index.js';

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

function mockRuntime(settings: Record<string, string | boolean> = {}): IAgentRuntime {
  const store = new Map<string, string | boolean | number | null>(Object.entries(settings));
  return {
    getSetting: (key: string) => store.get(key) ?? null,
    getService: () => null,
    fetch: globalThis.fetch,
  } as unknown as IAgentRuntime;
}

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

function collect() {
  const lines: string[] = [];
  const cb = async (r: Content) => {
    lines.push(r.text ?? '');
    return [];
  };
  return { lines, cb };
}

function assertRefusePacket(p: unknown, reason: string) {
  const r = p as Record<string, unknown>;
  assert.equal(r.schema, 'twzrd.gate_eval_refuse.v1');
  assert.equal(r.rail, 'eliza-plugin');
  assert.equal(r.subject, SELLER);
  assert.equal(r.reason, reason);
  assert.equal(r.signer_invocation_count, 0);
  assert.equal(r.usdc_spent, 0);
  assert.ok(!Number.isNaN(Date.parse(String(r.at))));
}

describe('merchant_card is fail-closed', () => {
  it('unavailable card refuses pay and never advises fail-open', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => json({ error: 'down' }, 503)) as typeof fetch;
    try {
      const { lines, cb } = collect();
      const result = (await merchantCardAction.handler!(
        mockRuntime(),
        mockMemory({ pubkey: SELLER }),
        undefined,
        undefined,
        cb,
      )) as { success: boolean; error?: string; data?: Record<string, unknown> };
      assert.equal(result.success, false);
      assert.equal(result.data?.refuse_pay, true);
      const text = lines.join('\n');
      assert.doesNotMatch(text, /fail-open/i);
      assert.match(text, /do not pay/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('reports coverage; unknown coverage is not a clean bill', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      json({ merchant: SELLER, wash_flagged: null, confidence: 'partial_inbound_only' })) as typeof fetch;
    try {
      const { lines, cb } = collect();
      const result = (await merchantCardAction.handler!(
        mockRuntime(),
        mockMemory({ pubkey: SELLER }),
        undefined,
        undefined,
        cb,
      )) as { success: boolean; data?: Record<string, unknown> };
      assert.equal(result.success, true);
      assert.equal(result.data?.wash_confidence, 'partial_inbound_only');
      assert.equal(result.data?.coverage_full, false);
      assert.equal(result.data?.refuse_pay, false);
      assert.match(lines.join('\n'), /not a clean bill/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('full coverage and clean is reported as such', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => json({ merchant: SELLER, wash_flagged: false, confidence: 'full' })) as typeof fetch;
    try {
      const { lines, cb } = collect();
      const result = (await merchantCardAction.handler!(
        mockRuntime(),
        mockMemory({ pubkey: SELLER }),
        undefined,
        undefined,
        cb,
      )) as { data?: Record<string, unknown> };
      assert.equal(result.data?.coverage_full, true);
      assert.doesNotMatch(lines.join('\n'), /not a clean bill/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('paid trust needs a spend confirmation', () => {
  it('unconfirmed: refuses before any intel or trust request', async () => {
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json({ readiness_card: { decision: 'allow', trust_score: 80, can_spend: true } });
    }) as typeof fetch;
    let payAttempted = false;
    setPayingFetch((async (input: RequestInfo | URL) => {
      urls.push(String(input));
      payAttempted = true;
      return json({});
    }) as typeof fetch);
    try {
      const { lines, cb } = collect();
      const result = (await intelTrustAction.handler!(
        mockRuntime(),
        mockMemory({ pubkey: SELLER }),
        undefined,
        undefined,
        cb,
      )) as { success: boolean; error?: string; data?: { refuse?: unknown } };
      assert.equal(result.success, false);
      assert.equal(result.error, 'spend_not_confirmed');
      assertRefusePacket(result.data?.refuse, 'spend_not_confirmed');
      assert.equal(payAttempted, false);
      assert.equal(urls.some((u) => u.includes('/v1/intel/trust/')), false, 'no trust request');
      assert.match(lines.join('\n'), /No payment was sent/);
    } finally {
      globalThis.fetch = realFetch;
      clearPayingFetch();
    }
  });

  it('WZRD_INTEL_ALLOW_PAID with a gate allow proceeds to the trust fetch', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/merchant_card/')) return json({ merchant: SELLER, wash_flagged: false });
      return json({ readiness_card: { decision: 'allow', trust_score: 80, can_spend: true } });
    }) as typeof fetch;
    const paid: string[] = [];
    setPayingFetch((async (input: RequestInfo | URL) => {
      paid.push(String(input));
      return json({ pubkey: SELLER, trust: { score: 70 }, paid: true });
    }) as typeof fetch);
    try {
      const { cb } = collect();
      const result = (await intelTrustAction.handler!(
        mockRuntime({ WZRD_INTEL_ALLOW_PAID: 'true' }),
        mockMemory({ pubkey: SELLER }),
        undefined,
        undefined,
        cb,
      )) as { success: boolean };
      assert.equal(result.success, true);
      assert.ok(paid.some((u) => u.includes(`/v1/intel/trust/${SELLER}`)), 'trust fetched');
    } finally {
      globalThis.fetch = realFetch;
      clearPayingFetch();
    }
  });

  it('a gate block carries the refuse packet', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/merchant_card/')) return json({ merchant: SELLER, wash_flagged: true });
      return json({ readiness_card: { decision: 'allow', trust_score: 80, can_spend: true } });
    }) as typeof fetch;
    setPayingFetch((async () => json({})) as typeof fetch);
    try {
      const { cb } = collect();
      const result = (await intelTrustAction.handler!(
        mockRuntime(),
        mockMemory({ pubkey: SELLER, confirm_spend: true }),
        undefined,
        undefined,
        cb,
      )) as { error?: string; data?: { refuse?: unknown } };
      assert.equal(result.error, 'wash_flagged');
      assertRefusePacket(result.data?.refuse, 'wash_flagged');
    } finally {
      globalThis.fetch = realFetch;
      clearPayingFetch();
    }
  });

  it('paidLookupConfirmed accepts only explicit confirmations', () => {
    assert.equal(paidLookupConfirmed(mockRuntime(), {}), false);
    assert.equal(paidLookupConfirmed(mockRuntime({ WZRD_INTEL_ALLOW_PAID: 'false' }), {}), false);
    assert.equal(paidLookupConfirmed(mockRuntime(), { confirm_spend: 'true' }), false);
    assert.equal(paidLookupConfirmed(mockRuntime({ WZRD_INTEL_ALLOW_PAID: '1' }), {}), true);
    assert.equal(paidLookupConfirmed(mockRuntime({ WZRD_INTEL_ALLOW_PAID: true }), {}), true);
    assert.equal(paidLookupConfirmed(mockRuntime(), { confirm_spend: true }), true);
    assertRefusePacket(refusePacket('x', SELLER), 'x');
  });
});

describe('installTwzrdAutoGate attribution', () => {
  it('defaults to eliza-plugin/<version> with a run id', () => {
    const opts = autoGateOptions();
    assert.match(opts.attribution?.integration ?? '', /^eliza-plugin\/\d+\.\d+\.\d+/);
    assert.ok((opts.attribution?.runId ?? '').length > 0);
    const kept = autoGateOptions({ failOpen: false });
    assert.equal(kept.failOpen, false);
    assert.ok(kept.attribution);
  });

  it('caller attribution wins', () => {
    const mine = { integration: 'my-host/1.0', runId: 'r1' };
    assert.deepEqual(autoGateOptions({ attribution: mine }).attribution, mine);
  });
});
