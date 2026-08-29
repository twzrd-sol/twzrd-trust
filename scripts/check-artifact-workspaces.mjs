import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
const dirs = ['twzrd-mcp-server', 'eliza-plugin', 'plugin-trustgate'];
for (const dir of dirs) {
  const pkg = JSON.parse(await readFile(join(dir, 'package.json')));
  const targets = [pkg.main, ...(pkg.bin ? Object.values(pkg.bin) : []), ...(pkg.files ?? [])];
  for (const target of targets) await access(join(dir, target));
}
console.log('artifact workspaces verified');
