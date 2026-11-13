import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGateReleaseDrift } from './check-gate-release-drift.mjs';

const version = '0.12.5';
function fixtureFetch(override = {}) {
  return async url => {
    if (Object.hasOwn(override, url)) return new Response(override[url], { status: 200 });
    let value;
    if (url.endsWith('/latest')) value = { name: 'twzrd-x402-gate', license: 'MIT', version };
    else if (url.endsWith('/health')) value = { status: 'ok', gate_npm: `twzrd-x402-gate@${version}` };
    else if (url.endsWith('/agent.json')) value = { capabilities: { gate_package: `twzrd-x402-gate@${version}` } };
    else return new Response(`npm install twzrd-x402-gate@${version}`);
    return Response.json(value);
  };
}
test('matching package and all hosted install pins pass', async () => {
  const result = await checkGateReleaseDrift({ version, fetch: fixtureFetch() });
  assert.equal(result.verified, true);
  assert.equal(result.checks.length, 5);
});
test('one stale install anywhere in a document fails even beside a current pin', async () => {
  const result = await checkGateReleaseDrift({ version, fetch: fixtureFetch({
    'https://intel.twzrd.xyz/skill.md': 'twzrd-x402-gate@0.12.5 and npm install twzrd-x402-gate@0.12.4',
  }) });
  assert.equal(result.verified, false);
  assert.equal(result.checks.find(check => check.source === 'skill').ok, false);
});
test('missing pins, bad metadata, HTTP errors and fetch failures cannot pass', async () => {
  for (const fetch of [
    async () => new Response('no pin'),
    async () => new Response('', { status: 503 }),
    async () => { throw new Error('offline'); },
  ]) {
    const result = await checkGateReleaseDrift({ version, fetch });
    assert.equal(result.verified, false);
    assert.ok(result.checks.every(check => !check.ok));
  }
});
test('registry version drift fails', async () => {
  const result = await checkGateReleaseDrift({ version, fetch: fixtureFetch({
    'https://registry.npmjs.org/twzrd-x402-gate/latest': JSON.stringify({ name: 'twzrd-x402-gate', license: 'MIT', version: '0.12.6' }),
  }) });
  assert.equal(result.verified, false);
});
test('a dated "shipped in" changelog line is history, not a pin', async () => {
  const history = '- 2026-11-10: `.kill`/`.pause` halt payments; shipped in `twzrd-x402-gate@0.12.0`.';
  const current = await checkGateReleaseDrift({ version, fetch: fixtureFetch({
    'https://intel.twzrd.xyz/llms.txt': `npm install twzrd-x402-gate@${version}\n${history}`,
  }) });
  assert.equal(current.verified, true);
  assert.deepEqual(current.checks.find(check => check.source === 'llms').pins, [version]);
  // History alone is not install guidance, and a stale install line beside it still fails.
  const onlyHistory = await checkGateReleaseDrift({ version, fetch: fixtureFetch({ 'https://intel.twzrd.xyz/llms.txt': history }) });
  assert.equal(onlyHistory.checks.find(check => check.source === 'llms').ok, false);
  const stale = await checkGateReleaseDrift({ version, fetch: fixtureFetch({
    'https://intel.twzrd.xyz/llms.txt': `npm install twzrd-x402-gate@0.12.4\n${history}`,
  }) });
  assert.equal(stale.checks.find(check => check.source === 'llms').ok, false);
});
