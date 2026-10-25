// Shared guard vectors (docs/vectors), run through @wzrd_sol/plugin-trustgate.
//
// plugin-trustgate/dist here is the mirror of the published package, and checkTrust
// is the guard behind its eliza provider and its Faremeter payerChooser. It reads the
// preflight readiness card and nothing else: no merchant card, no cap, no unevaluated
// rule. So it reaches a different outcome than the vectors on most of them, and
// fixing that is a change to its source in wzrd-final, not to this mirror.
//
// This test pins that state exactly instead of going red on every run: every vector
// either agrees, or is in KNOWN_DIVERGENCE with the outcome trustgate reaches today.
// A new divergence fails, a divergence that changes shape fails, and a divergence
// that goes away fails until it is removed from the list. A new mirror version fails
// until the list is re-measured against it.
//
// checkTrust's native result maps onto payment_decision.v1 as: preflight not
// answered (gateAvailable false) -> unavailable / INTEL_UNAVAILABLE; blocked ->
// block / INTEL_BLOCK; decision warn -> warn / INTEL_WARN; else allow / ALLOW.
// pays is !blocked. Intel is a stub at checkTrust's fetchImpl; any other fetch fails.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { checkTrust } from '../plugin-trustgate/dist/gate.js';

const GUARD = 'plugin-trustgate';
const MEASURED_VERSION = '0.3.10';
const INTEL = 'https://intel.vectors.invalid';
const FILE = JSON.parse(
  readFileSync(new URL('../docs/vectors/twzrd.payment_decision.v1.guard-vectors.json', import.meta.url), 'utf8'),
);
const VERSION = JSON.parse(readFileSync(new URL('../plugin-trustgate/package.json', import.meta.url), 'utf8')).version;

/** What plugin-trustgate 0.3.10 does on each vector it disagrees with, and why. */
const KNOWN_DIVERGENCE = {
  warn_over_cap: { pays: true, decision: 'warn', reason_code: 'INTEL_WARN', why: 'no cap check: a warn is paid at any price' },
  warn_no_cap: { pays: true, decision: 'warn', reason_code: 'INTEL_WARN', why: 'no cap check: a warn with no cap is paid' },
  missing_readiness_card: { pays: true, decision: 'warn', reason_code: 'INTEL_WARN', why: 'a card with no decision reads as warn, and a missing trust_score never fails minScore' },
  missing_merchant_card: { pays: true, decision: 'allow', reason_code: 'ALLOW', why: 'never reads the merchant card' },
  unevaluated: { pays: true, decision: 'warn', reason_code: 'INTEL_WARN', why: 'no unevaluated rule: null_reason and score null are ignored' },
  unevaluated_within_cap_opted_in: { pays: true, decision: 'warn', reason_code: 'INTEL_WARN', why: 'pays, as expected, but cannot tell an unknown counterparty from intel\'s warn' },
  wash_true: { pays: true, decision: 'allow', reason_code: 'ALLOW', why: 'never reads the merchant card, so a measured wash finding does not refuse' },
  wash_unknown: { pays: true, decision: 'allow', reason_code: 'ALLOW', why: 'never reads the merchant card' },
  wash_partial: { pays: true, decision: 'allow', reason_code: 'ALLOW', why: 'never reads the merchant card' },
  stale_wash_evidence: { pays: true, decision: 'allow', reason_code: 'ALLOW', why: 'never reads the merchant card' },
  outage_merchant_card: { pays: true, decision: 'allow', reason_code: 'ALLOW', why: 'never reads the merchant card, so its outage is not seen' },
};

function policyConfig(policy) {
  // Only these two have a checkTrust equivalent; the rest are rules it does not have.
  return { failOpen: policy.fail_open, minScore: policy.min_trust_score };
}

async function runVector(v) {
  const unexpected = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u !== `${INTEL}/v1/intel/preflight`) {
      unexpected.push(u);
      throw new TypeError(`vector runner: unexpected intel request ${u}`);
    }
    const s = v.evidence.preflight;
    if (s.error) throw new TypeError(`fetch failed (${s.error})`);
    return new Response(JSON.stringify(s.body ?? {}), { status: s.status, headers: { 'content-type': 'application/json' } });
  };
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  globalThis.fetch = async (url) => {
    unexpected.push(String(url));
    throw new TypeError('vector runner: global fetch is not allowed');
  };
  console.warn = () => {};
  try {
    const r = await checkTrust(FILE.challenge.pay_to, {
      intelBase: INTEL,
      fetchImpl,
      ...policyConfig({ ...FILE.policy_baseline, ...v.policy }),
    });
    const [decision, reason_code] = !r.gateAvailable
      ? ['unavailable', 'INTEL_UNAVAILABLE']
      : r.blocked
        ? ['block', 'INTEL_BLOCK']
        : r.decision === 'warn'
          ? ['warn', 'INTEL_WARN']
          : ['allow', 'ALLOW'];
    return { observed: { pays: !r.blocked, decision, reason_code }, unexpected };
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
}

const vectors = FILE.vectors.filter((v) => v.applies_to.includes(GUARD));

test('guard vectors: plugin-trustgate is the version the known divergences were measured on', () => {
  assert.equal(VERSION, MEASURED_VERSION, `plugin-trustgate is ${VERSION}; re-measure KNOWN_DIVERGENCE against it`);
  const ids = new Set(FILE.vectors.map((v) => v.id));
  for (const id of Object.keys(KNOWN_DIVERGENCE)) assert.ok(ids.has(id), `KNOWN_DIVERGENCE names a vector that does not exist: ${id}`);
  for (const v of FILE.vectors) {
    const applies = v.applies_to.includes(GUARD);
    assert.ok(applies !== Boolean(v.not_applicable?.[GUARD]), `[vector ${v.id}] must either apply to ${GUARD} or say why not`);
  }
});

for (const v of vectors) {
  test(`guard vector ${v.id} (${v.covers}): plugin-trustgate`, async (t) => {
    const at = `[vector ${v.id}] ${GUARD}`;
    const { observed, unexpected } = await runVector(v);
    assert.deepEqual(unexpected, [], `${at}: fetched something the vector does not serve`);
    const expected = { pays: v.expect.pays, decision: v.expect.decision, reason_code: v.expect.reason_code };
    const known = KNOWN_DIVERGENCE[v.id];
    if (!known) {
      assert.deepEqual(observed, expected, `${at}: reached ${JSON.stringify(observed)}, expected ${JSON.stringify(expected)}`);
      return;
    }
    const { why, ...pinned } = known;
    assert.notDeepEqual(observed, expected, `${at}: now agrees with the vector; remove it from KNOWN_DIVERGENCE`);
    assert.deepEqual(observed, pinned, `${at}: diverges differently than recorded (${why})`);
    t.diagnostic(`known divergence: ${why}`);
  });
}

test('guard vectors: plugin-trustgate tally', (t) => {
  const diverge = vectors.filter((v) => KNOWN_DIVERGENCE[v.id]).length;
  t.diagnostic(`plugin-trustgate ${VERSION}: agrees on ${vectors.length - diverge} of ${vectors.length} vectors, ${diverge} known divergences`);
});
