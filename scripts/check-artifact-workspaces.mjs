import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const dirs = ['twzrd-mcp-server', 'eliza-plugin', 'plugin-trustgate'];
for (const dir of dirs) {
  const pkg = JSON.parse(await readFile(join(dir, 'package.json')));
  const targets = [pkg.main, ...(pkg.bin ? Object.values(pkg.bin) : []), ...(pkg.files ?? [])];
  for (const target of targets) await access(join(dir, target));
}
const baselineDir = await mkdtemp(join(tmpdir(), 'twzrd-eliza-source-baseline-'));
try {
  await execFileAsync(process.execPath, ['scripts/extract-eliza-source-baseline.mjs', '--target', baselineDir]);
  await Promise.all([
    readFile(join(baselineDir, 'src/actions/intel-trust.ts'), 'utf8'),
    readFile(join(baselineDir, 'src/actions/verify-receipt.ts'), 'utf8'),
    readFile(join(baselineDir, 'test/plugin-registration.intel.ts'), 'utf8'),
  ]);
  await execFileAsync(process.execPath, ['scripts/inventory-eliza-migration.mjs']);
  const sourceWorkspaceDir = await mkdtemp(join(tmpdir(), 'twzrd-eliza-source-workspace-'));
  try {
    await execFileAsync(process.execPath, [
      'scripts/prepare-eliza-source-workspace.mjs',
      '--target',
      sourceWorkspaceDir,
    ]);
    await Promise.all([
      readFile(join(sourceWorkspaceDir, 'source/src/actions/intel-trust.ts'), 'utf8'),
      readFile(join(sourceWorkspaceDir, 'current-dist/actions/merchant-card.js'), 'utf8'),
      readFile(join(sourceWorkspaceDir, 'migration-inventory.json'), 'utf8'),
    ]);
  } finally {
    await rm(sourceWorkspaceDir, { recursive: true, force: true });
  }
} finally {
  await rm(baselineDir, { recursive: true, force: true });
}
console.log('artifact workspaces verified');
