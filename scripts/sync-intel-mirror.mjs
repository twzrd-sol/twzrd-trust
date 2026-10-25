#!/usr/bin/env node
// Keeps server/llms.txt and server/.well-known/mcp.json equal to the live intel copies.
// mcp.json's `build` block (sha, image digest) changes on every deploy, so the mirror omits it.
// Default mode writes; --check exits 1 on drift and writes nothing. Fetch errors exit 2 and never write.
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const LLMS_URL = 'https://intel.twzrd.xyz/llms.txt';
const MCP_URL = 'https://intel.twzrd.xyz/.well-known/mcp.json';
const MAX_BYTES = 1_048_576;
const DEFAULT_LLMS = new URL('../server/llms.txt', import.meta.url);
const DEFAULT_MCP = new URL('../server/.well-known/mcp.json', import.meta.url);

async function fetchText(fetchFn, url) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`${url} exceeds 1 MiB`);
  return text;
}

export function mirrorMcp(text) {
  const card = JSON.parse(text);
  delete card.build;
  return `${JSON.stringify(card, null, 2)}\n`;
}

export async function syncIntelMirror({
  fetch: fetchFn = globalThis.fetch,
  llmsPath = DEFAULT_LLMS,
  mcpPath = DEFAULT_MCP,
  write = false,
} = {}) {
  const [liveLlms, liveMcp] = await Promise.all([fetchText(fetchFn, LLMS_URL), fetchText(fetchFn, MCP_URL)]);
  const wantMcp = mirrorMcp(liveMcp);
  const haveLlms = readFileSync(llmsPath, 'utf8');
  const haveMcp = readFileSync(mcpPath, 'utf8');
  const drift = [];
  if (haveLlms !== liveLlms) drift.push({ file: 'server/llms.txt', summary: 'bytes differ from live llms.txt' });
  if (haveMcp !== wantMcp) {
    const live = JSON.parse(wantMcp);
    const have = JSON.parse(haveMcp);
    delete have.build;
    const summary = isDeepStrictEqual(live, have)
      ? 'formatting or build block differs from the canonical mirror form'
      : `gate_npm ${have.gate_npm ?? 'none'} -> ${live.gate_npm ?? 'none'}; mirror content differs from live`;
    drift.push({ file: 'server/.well-known/mcp.json', summary });
  }
  if (write) {
    if (haveLlms !== liveLlms) writeFileSync(llmsPath, liveLlms);
    if (haveMcp !== wantMcp) writeFileSync(mcpPath, wantMcp);
  }
  return { schema: 'twzrd.intel_mirror_sync.v1', drift, written: write ? drift.length > 0 : false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = !process.argv.includes('--check');
  try {
    const result = await syncIntelMirror({ write });
    console.log(JSON.stringify(result, null, 2));
    if (!write && result.drift.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`intel mirror sync failed closed: ${error.message}`);
    process.exitCode = 2;
  }
}
