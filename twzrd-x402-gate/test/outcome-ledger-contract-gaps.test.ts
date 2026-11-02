// Pilot-contract gaps G1/G2 found by the codex discovery run (ops-history 2026-10-30-preflight-workflow-discovery),
// RED on c4d3db733c and 3d9e654; pinned GREEN by the operation key and settlement-evidence changes in #274.
// All traffic, signatures and settlement headers are synthetic and in-process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { x402Client } from '@x402/fetch';
import type { SchemeNetworkClient } from '@x402/core/types';
import { createGuardedX402Fetch } from '../src/guarded-x402-fetch.js';
import { createMemoryOutcomeLedger } from '../src/outcome-ledger.js';

const resource = 'https://offline.example/headers';
const network = 'eip155:8453';
const seller = '0x00000000000000000000000000000000000000a1';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
function setup(paid: () => Response) {
  let amount = '1000';
  let signs = 0;
  const ledger = createMemoryOutcomeLedger();
  const client = x402Client.fromConfig({ schemes: [], spendControls: false as const });
  const scheme: SchemeNetworkClient = {
    scheme: 'exact',
    async createPaymentPayload(x402Version) {
      signs++;
      return { x402Version, payload: { signature: 'offline', authorization: { to: seller, value: amount } } };
    },
  };
  client.register(network, scheme);
  const transport: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.headers.has('PAYMENT-SIGNATURE')) return paid();
    const challenge = { x402Version: 2, resource: { url: resource }, accepts: [{
      scheme: 'exact', network, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount, payTo: seller, maxTimeoutSeconds: 60, extra: {},
    }] };
    return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': b64(challenge) } });
  };
  return { ledger, signs: () => signs, setAmount: (v: string) => { amount = v; },
    fetch: createGuardedX402Fetch({ client, fetch: transport, twzrd: { disabled: true }, outcomeLedger: ledger }) };
}

test('PILOT GAP: unresolved logical operation blocks a changed-price retry', async () => {
  const h = setup(() => { throw new Error('response lost after payment signature'); });
  await assert.rejects(h.fetch(resource), /response lost/);
  assert.equal(h.signs(), 1);
  assert.equal(h.ledger.unresolved().length, 1);
  // The same logical operation remains unresolved even if new terms are offered.
  h.setAmount('2000');
  await assert.rejects(h.fetch(resource));
  assert.equal(h.signs(), 1, 'must reconcile operation before signing changed terms');
});

test('PILOT GAP: unvalidated result and relayed settlement header cannot establish completed', async () => {
  const h = setup(() => new Response('not the requested structured result', { status: 200, headers: {
    'PAYMENT-RESPONSE': b64({ success: true, transaction: '0x' + 'ab'.repeat(32), network,
                            payer: '0x00000000000000000000000000000000000000b2' }),
  } }));
  await h.fetch(resource);
  assert.equal(h.signs(), 1);
  assert.equal(h.ledger.unresolved().length, 1,
    'operation stays unknown pending independent settlement and bound result validation');
});
