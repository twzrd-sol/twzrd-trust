import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const list = (dir, ext) => readdirSync(new URL(dir, root)).filter(file => file.endsWith(ext));
const frontmatter = (path) => {
  const match = read(path).match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${path} has no frontmatter`);
  return Object.fromEntries(match[1].split('\n').map(line => line.match(/^([A-Za-z]+):\s*(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
};

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

test('the Cursor Plugin manifest matches plugin.json and keeps default component discovery', () => {
  const agentManifest = JSON.parse(read('plugin.json'));
  const cursorManifest = JSON.parse(read('.cursor-plugin/plugin.json'));
  for (const key of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']) {
    assert.deepEqual(cursorManifest[key], agentManifest[key], key);
  }
  // A path field replaces folder discovery for its component, so the manifest sets none.
  for (const key of ['rules', 'skills', 'commands', 'agents', 'hooks', 'mcpServers']) {
    assert.equal(Object.hasOwn(cursorManifest, key), false, key);
  }
});

test('rules and commands carry the frontmatter Cursor reads', () => {
  const rules = list('rules/', '.mdc');
  const commands = list('commands/', '.md');
  assert.ok(rules.length > 0 && commands.length > 0);
  for (const file of rules) {
    const meta = frontmatter(`rules/${file}`);
    assert.ok(meta.description, file);
    assert.equal(meta.alwaysApply, 'false', file);
  }
  for (const file of commands) {
    const meta = frontmatter(`commands/${file}`);
    assert.equal(meta.name, file.replace(/\.md$/, ''));
    assert.ok(meta.description, file);
  }
});

test('the rule and command name tools the intel MCP server lists', () => {
  const tools = new Set(JSON.parse(read('server/.well-known/mcp.json')).tools.map(tool => tool.name));
  for (const path of ['rules/x402-pre-spend.mdc', 'commands/check-seller.md']) {
    for (const tool of ['evaluate_x402_resource', 'get_merchant_card']) {
      assert.ok(read(path).includes(`\`${tool}\``), `${path} cites ${tool}`);
      assert.ok(tools.has(tool), `intel lists ${tool}`);
    }
  }
});
