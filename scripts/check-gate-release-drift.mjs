#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageUrl = new URL('../twzrd-x402-gate/package.json', import.meta.url);
export async function checkGateReleaseDrift({ fetch: fetchFn = globalThis.fetch, version } = {}) {
  const expected = version ?? JSON.parse(readFileSync(packageUrl, 'utf8')).version;
  const checks = await Promise.all([
    ['npm', 'https://registry.npmjs.org/twzrd-x402-gate/latest'],
    ['health', 'https://intel.twzrd.xyz/health'],
    ['agent', 'https://intel.twzrd.xyz/.well-known/agent.json'],
    ['llms', 'https://intel.twzrd.xyz/llms.txt'],
    ['skill', 'https://intel.twzrd.xyz/skill.md'],
  ].map(async ([source, url]) => {
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text) > 1_048_576) throw new Error('response exceeds 1 MiB');
      let pins;
      if (source === 'npm') {
        const metadata = JSON.parse(text);
        if (metadata.name !== 'twzrd-x402-gate' || metadata.license !== 'MIT') throw new Error('unexpected package identity/license');
        pins = [metadata.version];
      } else if (source === 'health') {
        const health = JSON.parse(text);
        if (health.status !== 'ok') throw new Error(`health status ${health.status}`);
        pins = [health.gate_npm?.replace(/^twzrd-x402-gate@/, '')];
      } else if (source === 'agent') {
        const agent = JSON.parse(text);
        pins = [agent.capabilities?.gate_package?.replace(/^twzrd-x402-gate@/, '')];
      } else {
        pins = [...new Set([...text.matchAll(/twzrd-x402-gate@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)].map(match => match[1]))];
      }
      const ok = pins.length > 0 && pins.every(pin => pin === expected);
      return { source, url, ok, pins, expected };
    } catch (error) {
      return { source, url, ok: false, expected, error: error.message };
    }
  }));
  return { schema: 'twzrd.gate_release_drift.v1', expected_version: expected, checks, verified: checks.every(check => check.ok) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await checkGateReleaseDrift();
  console.log(JSON.stringify(result, null, 2));
  if (!result.verified) process.exitCode = 1;
}
