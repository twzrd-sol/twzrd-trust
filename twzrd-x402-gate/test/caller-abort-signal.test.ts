// The caller's AbortSignal governs the whole guarded call, the paid retry included.
//
// 2026-11-17: on Node 24 a cloned Request stops following its source's signal
// after a garbage collection, and @x402/fetch sends the paid retry as a clone of
// a clone. A caller's 300 ms timeout was then ignored on a paid request that
// never answered: the call hung for about 300 s (the transport's own limit).
// These tests force that collection between the clone and the paid request.
// Real loopback HTTP and the real fetch transport; the signer is synthetic.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import { x402Client } from '@x402/fetch';
import type { SchemeNetworkClient } from '@x402/core/types';
import { createGuardedX402Fetch } from './guarded-fetch-fixture.js';

v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc') as () => void;

const network = 'eip155:8453';
const seller = '0x00000000000000000000000000000000000000a1';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
/** A failed guarantee must fail the test in seconds, never stall the suite. */
const STALL_MS = 5_000;

let server: http.Server;
let base = '';
let unpaidSeen = 0;
let paidSeen = 0;
let paidClosed = 0;
let answerPaid = false;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers['payment-signature']) {
      paidSeen++;
      if (answerPaid) { res.writeHead(200); res.end('ok'); return; }
      res.on('close', () => { paidClosed++; });
      return; // never answers
    }
    unpaidSeen++;
    const challenge = { x402Version: 2, resource: { url: `${base}${req.url}` }, accepts: [{
      scheme: 'exact', network, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1000', payTo: seller, maxTimeoutSeconds: 60, extra: {},
    }] };
    res.writeHead(402, { 'PAYMENT-REQUIRED': b64(challenge) });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function setup(options: { beforeGate?: () => void; hourlyBudgetCap?: string } = {}) {
  let signs = 0;
  const client = x402Client.fromConfig({ schemes: [], spendControls: false as const });
  // Registered before the gate's own hook, so it runs first in each payment.
  if (options.beforeGate) {
    const beforeGate = options.beforeGate;
    client.onBeforePaymentCreation(async () => { beforeGate(); return undefined; });
  }
  const scheme: SchemeNetworkClient = {
    scheme: 'exact',
    async createPaymentPayload(x402Version) {
      signs++;
      // Between @x402/fetch's request.clone() and its paid fetch: let the
      // unpaid leg's garbage become collectable, then collect it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      collect();
      return { x402Version, payload: { signature: 'offline', authorization: { to: seller, value: '1000' } } };
    },
  };
  client.register(network, scheme);
  return {
    signs: () => signs,
    fetch: createGuardedX402Fetch({
      client,
      twzrd: { disabled: true },
      ...(options.hourlyBudgetCap ? { hourlyBudgetCap: options.hourlyBudgetCap } : {}),
    }),
  };
}

/** Settle within STALL_MS or report a stall; never leave the test hanging. */
async function outcomeOf(call: Promise<Response>): Promise<{ error?: unknown; status?: number; ms: number }> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const stall = new Promise<{ error: unknown }>((resolve) => {
    timer = setTimeout(() => resolve({ error: new Error('STALLED: the caller signal was not honoured') }), STALL_MS);
  });
  const result = await Promise.race([call.then((r) => ({ status: r.status }), (error: unknown) => ({ error })), stall]);
  clearTimeout(timer);
  return { ...result, ms: Date.now() - started };
}

async function until(condition: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
}

test('a timeout in init aborts a paid request that never answers, after a GC', async () => {
  const h = setup();
  const [paidBefore, closedBefore] = [paidSeen, paidClosed];
  const out = await outcomeOf(h.fetch(`${base}/a`, { signal: AbortSignal.timeout(300) }));
  assert.equal((out.error as Error | undefined)?.name, 'TimeoutError', String((out.error as Error | undefined)?.message));
  assert.ok(out.ms < 2_000, `rejected after ${out.ms} ms`);
  assert.equal(h.signs(), 1, 'the payment was signed before the timeout');
  assert.equal(paidSeen, paidBefore + 1, 'the paid request reached the seller');
  // The transport itself was cancelled, not just the promise.
  assert.ok(await until(() => paidClosed === closedBefore + 1), 'the paid connection was closed');
});

test('a signal carried by a Request aborts the paid request too, after a GC', async () => {
  const h = setup();
  const closedBefore = paidClosed;
  const controller = new AbortController();
  const reason = new Error('caller gave up');
  setTimeout(() => controller.abort(reason), 300);
  const out = await outcomeOf(h.fetch(new Request(`${base}/b`, { signal: controller.signal })));
  assert.equal(out.error, reason, 'rejects with the signal\'s own reason');
  assert.ok(out.ms < 2_000, `rejected after ${out.ms} ms`);
  assert.equal(h.signs(), 1);
  assert.ok(await until(() => paidClosed === closedBefore + 1), 'the paid connection was closed');
});

test('an already aborted signal rejects with its reason before any request or signature', async () => {
  const h = setup();
  const [unpaidBefore, paidBefore] = [unpaidSeen, paidSeen];
  const reason = new Error('aborted before the call');
  const out = await outcomeOf(h.fetch(`${base}/c`, { signal: AbortSignal.abort(reason) }));
  assert.equal(out.error, reason);
  assert.equal(h.signs(), 0);
  assert.equal(unpaidSeen, unpaidBefore);
  assert.equal(paidSeen, paidBefore);
});

/**
 * Track the abort listeners the guarded fetch itself puts on a signal. Node's
 * own fetch and Request also listen on it and drop theirs only at a later
 * garbage collection, so the signal's total listener count is not ours to assert.
 */
function watchGateListeners(signal: AbortSignal): { added: () => number; left: () => number } {
  const ours = new Set<unknown>();
  let added = 0;
  const add = signal.addEventListener.bind(signal) as (...args: unknown[]) => void;
  const remove = signal.removeEventListener.bind(signal) as (...args: unknown[]) => void;
  Object.defineProperty(signal, 'addEventListener', { configurable: true, value: (...args: unknown[]) => {
    // Line 2 of the stack is the direct caller. Node's fetch also adds
    // listeners from inside calls the gate makes; those are not the gate's.
    const caller = (new Error().stack ?? '').split('\n')[2] ?? '';
    if (args[0] === 'abort' && /guarded-x402-fetch/.test(caller)) { ours.add(args[1]); added++; }
    return add(...args);
  } });
  Object.defineProperty(signal, 'removeEventListener', { configurable: true, value: (...args: unknown[]) => {
    if (args[0] === 'abort') ours.delete(args[1]);
    return remove(...args);
  } });
  return { added: () => added, left: () => ours.size };
}

test('the guarded fetch removes its own abort listener, on success and on abort', async () => {
  const h = setup();
  answerPaid = true;
  try {
    const controller = new AbortController();
    const watch = watchGateListeners(controller.signal);
    for (let i = 0; i < 5; i++) {
      const response = await h.fetch(`${base}/d${i}`, { signal: controller.signal });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal(watch.added(), 5, 'the watcher saw the gate add one listener per call');
    assert.equal(watch.left(), 0, 'gate listeners left after 5 successful calls');
  } finally {
    answerPaid = false;
  }
  const controller = new AbortController();
  const watch = watchGateListeners(controller.signal);
  setTimeout(() => controller.abort(), 300);
  const out = await outcomeOf(h.fetch(`${base}/e`, { signal: controller.signal }));
  assert.equal((out.error as Error | undefined)?.name, 'AbortError');
  assert.equal(watch.added(), 1);
  assert.equal(watch.left(), 0, 'gate listeners left after an aborted call');
});

test('a signal that fires while the pre-sign checks run: nothing is signed and no budget is charged', async () => {
  // The budget fits exactly one 1000-micro payment in the hour.
  let controller = new AbortController();
  const reason = new Error('gave up during the checks');
  let abortInHook = true;
  const h = setup({ hourlyBudgetCap: '0.001', beforeGate: () => { if (abortInHook) controller.abort(reason); } });
  const paidBefore = paidSeen;
  const out = await outcomeOf(h.fetch(`${base}/g`, { signal: controller.signal }));
  assert.equal(out.error, reason);
  // The abandoned call keeps running underneath; give it time to reach the signer if it is going to.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.signs(), 0, 'no payment was signed for a call the caller abandoned');
  assert.equal(paidSeen, paidBefore, 'no paid request was sent');
  // The whole hour's budget is still there: the next call pays.
  abortInHook = false;
  controller = new AbortController();
  answerPaid = true;
  try {
    const response = await h.fetch(`${base}/g2`, { signal: controller.signal });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(h.signs(), 1);
  } finally {
    answerPaid = false;
  }
});

test('init.signal null means no signal, as in fetch: a Request\'s aborted signal is not enforced', async () => {
  const h = setup();
  answerPaid = true;
  try {
    const request = new Request(`${base}/h`, { signal: AbortSignal.abort(new Error('ignored')) });
    const response = await h.fetch(request, { signal: null });
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    answerPaid = false;
  }
});

test('a call with no signal is unchanged: the paid response is returned', async () => {
  const h = setup();
  answerPaid = true;
  try {
    const response = await h.fetch(`${base}/f`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    assert.equal(h.signs(), 1);
  } finally {
    answerPaid = false;
  }
});
