import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { houseCallerHeaders } from './house-caller.mjs';
import { checkGateReleaseDrift } from './check-gate-release-drift.mjs';
import { syncIntelMirror } from './sync-intel-mirror.mjs';

const TAG = 'twzrd:internal:ci';

test('no variable, or an empty one, sends no caller tag', () => {
  assert.deepEqual(houseCallerHeaders({}), {});
  assert.deepEqual(houseCallerHeaders({ TWZRD_INTERNAL_CALLER: '' }), {});
});

test('a house tag becomes x-twzrd-caller', () => {
  assert.deepEqual(houseCallerHeaders({ TWZRD_INTERNAL_CALLER: TAG }), { 'x-twzrd-caller': TAG });
  assert.deepEqual(houseCallerHeaders({ TWZRD_INTERNAL_CALLER: 'twzrd:internal:mirror-sync' }), { 'x-twzrd-caller': 'twzrd:internal:mirror-sync' });
});

test('anything that is not twzrd:internal:<subsystem> is refused, not sent', () => {
  for (const bad of ['twzrd-x402-gate/0.20.0', 'twzrd:internal:', 'twzrd:internal:CI', 'twzrd:internal:ci\nx-evil: 1', 'internal', ` ${TAG}`]) {
    assert.throws(() => houseCallerHeaders({ TWZRD_INTERNAL_CALLER: bad }), /twzrd:internal:<subsystem>/, bad);
  }
});

function recordingFetch(seen, version) {
  return async (url, init = {}) => {
    seen.push({ url, headers: { ...(init.headers ?? {}) } });
    if (url.endsWith('/latest')) return Response.json({ name: 'twzrd-x402-gate', license: 'MIT', version });
    if (url.endsWith('/health')) return Response.json({ status: 'ok', gate_npm: `twzrd-x402-gate@${version}` });
    if (url.endsWith('/agent.json')) return Response.json({ capabilities: { gate_package: `twzrd-x402-gate@${version}` } });
    if (url.endsWith('/mcp.json')) return new Response(JSON.stringify({ name: 'twzrd' }));
    return new Response(`npm install twzrd-x402-gate@${version}`);
  };
}

test('release drift tags only intel requests, never the npm registry', async () => {
  const seen = [];
  const result = await checkGateReleaseDrift({ version: '0.20.0', fetch: recordingFetch(seen, '0.20.0'), env: { TWZRD_INTERNAL_CALLER: TAG } });
  assert.equal(result.verified, true);
  for (const { url, headers } of seen) {
    if (url.startsWith('https://registry.npmjs.org/')) assert.deepEqual(headers, {}, url);
    else assert.equal(headers['x-twzrd-caller'], TAG, url);
  }
  const untagged = [];
  await checkGateReleaseDrift({ version: '0.20.0', fetch: recordingFetch(untagged, '0.20.0'), env: {} });
  assert.ok(untagged.every(({ headers }) => !('x-twzrd-caller' in headers)));
});

test('mirror sync tags both intel fetches when set, and neither when unset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'house-caller-mirror-'));
  const llmsPath = join(dir, 'llms.txt');
  const mcpPath = join(dir, 'mcp.json');
  writeFileSync(llmsPath, 'x\n');
  writeFileSync(mcpPath, '{}\n');
  const seen = [];
  await syncIntelMirror({ fetch: recordingFetch(seen, '0.20.0'), llmsPath, mcpPath, env: { TWZRD_INTERNAL_CALLER: 'twzrd:internal:mirror-sync' } });
  assert.equal(seen.length, 2);
  assert.ok(seen.every(({ headers }) => headers['x-twzrd-caller'] === 'twzrd:internal:mirror-sync'));
  const untagged = [];
  await syncIntelMirror({ fetch: recordingFetch(untagged, '0.20.0'), llmsPath, mcpPath, env: {} });
  assert.ok(untagged.every(({ headers }) => !('x-twzrd-caller' in headers)));
});

test('README quickstart proof passes the tag to curl only when set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'house-caller-curl-'));
  const argsFile = join(dir, 'args');
  const fixture = join(dir, 'demo-gate.json');
  writeFileSync(fixture, JSON.stringify({ ok: true, mode: 'no_spend', steps: [{ name: 'block_path', verdict: 'block', approved: false, signer_invocations: 0 }] }));
  const fakeCurl = join(dir, 'curl');
  writeFileSync(fakeCurl, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\ncat "${fixture}"\n`);
  chmodSync(fakeCurl, 0o755);
  const script = fileURLToPath(new URL('./test-readme-quickstart.mjs', import.meta.url));
  const run = (extra) => {
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...extra };
    if (!('TWZRD_INTERNAL_CALLER' in extra)) delete env.TWZRD_INTERNAL_CALLER;
    execFileSync(process.execPath, [script], { env, encoding: 'utf8' });
    return readFileSync(argsFile, 'utf8').trim().split('\n');
  };
  assert.deepEqual(run({ TWZRD_INTERNAL_CALLER: TAG }), ['-fsS', '-H', `x-twzrd-caller: ${TAG}`, 'https://intel.twzrd.xyz/v1/intel/demo-gate']);
  assert.deepEqual(run({}), ['-fsS', 'https://intel.twzrd.xyz/v1/intel/demo-gate']);
});
