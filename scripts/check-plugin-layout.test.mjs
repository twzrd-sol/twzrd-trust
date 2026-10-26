import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('the plugin skill is byte-identical to the root SKILL.md', () => {
  assert.equal(read('skills/twzrd-trust/SKILL.md'), read('SKILL.md'));
});

test('.mcp.json points the plugin at the public intel MCP endpoint', () => {
  const config = JSON.parse(read('.mcp.json'));
  assert.deepEqual(Object.keys(config.mcpServers), ['twzrd-intel']);
  assert.equal(config.mcpServers['twzrd-intel'].url, 'https://intel.twzrd.xyz/mcp');
});
