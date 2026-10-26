import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('the plugin skill is byte-identical to the root SKILL.md', () => {
  assert.equal(read('skills/twzrd-trust/SKILL.md'), read('SKILL.md'));
});

test('mcp.json points the plugin at the public intel MCP endpoint', () => {
  const config = JSON.parse(read('mcp.json'));
  assert.deepEqual(Object.keys(config.mcpServers), ['twzrd-intel']);
  assert.equal(config.mcpServers['twzrd-intel'].url, 'https://intel.twzrd.xyz/mcp');
});

test('plugin.json is a closed Agent Plugins manifest with a valid name', () => {
  const manifest = JSON.parse(read('plugin.json'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.match(manifest.name, /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/);
  const allowed = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
  assert.deepEqual(Object.keys(manifest).filter(key => !allowed.has(key)), []);
});
