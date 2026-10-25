import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mirrorMcp, syncIntelMirror } from './sync-intel-mirror.mjs';

const LIVE_LLMS = '# TWZRD\nnpm install twzrd-x402-gate@0.13.1\n';
const LIVE_MCP = JSON.stringify({ name: 'twzrd', gate_npm: 'twzrd-x402-gate@0.13.1', build: { sha: 'bedb3804', image_digest: 'sha256:7f' } });

function fixtureFetch(overrides = {}) {
  return async url => {
    if (Object.hasOwn(overrides, url)) return overrides[url];
    if (url.endsWith('/llms.txt')) return new Response(LIVE_LLMS);
    if (url.endsWith('/mcp.json')) return new Response(LIVE_MCP);
    throw new Error(`unexpected url ${url}`);
  };
}

function mirror(llms, mcp) {
  const dir = mkdtempSync(join(tmpdir(), 'intel-mirror-test-'));
  const llmsPath = join(dir, 'llms.txt');
  const mcpPath = join(dir, 'mcp.json');
  writeFileSync(llmsPath, llms);
  writeFileSync(mcpPath, mcp);
  return { llmsPath, mcpPath };
}

test('mirrorMcp drops the build block and keeps the rest in canonical form', () => {
  const out = mirrorMcp(LIVE_MCP);
  assert.equal(out.includes('"build"'), false);
  assert.equal(out, `${JSON.stringify({ name: 'twzrd', gate_npm: 'twzrd-x402-gate@0.13.1' }, null, 2)}\n`);
});

test('write mode brings a stale mirror to canonical form, then a second run is clean', async () => {
  const paths = mirror('old\n', JSON.stringify({ name: 'twzrd', gate_npm: 'twzrd-x402-gate@0.12.5', build: { sha: 'old' } }));
  const first = await syncIntelMirror({ fetch: fixtureFetch(), ...paths, write: true });
  assert.equal(first.drift.length, 2);
  assert.equal(first.written, true);
  assert.equal(readFileSync(paths.llmsPath, 'utf8'), LIVE_LLMS);
  assert.equal(readFileSync(paths.mcpPath, 'utf8'), mirrorMcp(LIVE_MCP));
  const second = await syncIntelMirror({ fetch: fixtureFetch(), ...paths });
  assert.deepEqual(second.drift, []);
  assert.equal(second.written, false);
});

test('check mode reports a changed gate pin without writing', async () => {
  const paths = mirror(LIVE_LLMS, mirrorMcp(LIVE_MCP.replace('0.13.1', '0.13.0')));
  const result = await syncIntelMirror({ fetch: fixtureFetch(), ...paths });
  assert.equal(result.drift.length, 1);
  assert.equal(result.drift[0].file, 'server/.well-known/mcp.json');
  assert.match(result.drift[0].summary, /gate_npm twzrd-x402-gate@0\.13\.0 -> twzrd-x402-gate@0\.13\.1/);
  assert.equal(result.written, false);
});

test('a byte-only difference in llms.txt is drift', async () => {
  const paths = mirror(`${LIVE_LLMS} `, mirrorMcp(LIVE_MCP));
  const result = await syncIntelMirror({ fetch: fixtureFetch(), ...paths });
  assert.deepEqual(result.drift.map(d => d.file), ['server/llms.txt']);
});

test('a build-only difference in the mirror is not content drift', async () => {
  const paths = mirror(LIVE_LLMS, JSON.stringify({ name: 'twzrd', gate_npm: 'twzrd-x402-gate@0.13.1', build: { sha: 'stale' } }, null, 2) + '\n');
  const result = await syncIntelMirror({ fetch: fixtureFetch(), ...paths });
  assert.deepEqual(result.drift.map(d => d.file), ['server/.well-known/mcp.json']);
  assert.match(result.drift[0].summary, /formatting or build block/);
});

test('fetch failures fail closed and never write', async () => {
  const before = { llms: 'keep\n', mcp: '{"keep":true}\n' };
  for (const overrides of [
    { 'https://intel.twzrd.xyz/llms.txt': new Response('down', { status: 503 }) },
    { 'https://intel.twzrd.xyz/.well-known/mcp.json': new Response('{}', { status: 404 }) },
    { 'https://intel.twzrd.xyz/llms.txt': new Response('x'.repeat(1_048_577)) },
  ]) {
    const paths = mirror(before.llms, before.mcp);
    await assert.rejects(syncIntelMirror({ fetch: fixtureFetch(overrides), ...paths, write: true }));
    assert.equal(readFileSync(paths.llmsPath, 'utf8'), before.llms);
    assert.equal(readFileSync(paths.mcpPath, 'utf8'), before.mcp);
  }
});
