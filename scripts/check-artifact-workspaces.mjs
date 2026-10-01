import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const dirs = ['twzrd-mcp-server', 'eliza-plugin', 'plugin-trustgate'];
for (const dir of dirs) {
  const pkg = JSON.parse(await readFile(join(dir, 'package.json')));
  // npm accepts `bin` as a bare path string as well as a name → path map.
  const bins = (typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {}))
    .map((bin) => bin.replace(/^\.\//, ''));
  const targets = [pkg.main, ...bins, ...(pkg.files ?? [])];
  for (const target of targets) await access(join(dir, target));
  // Every bin must be 100755 in git. npm chmods bins on install, so a 100644 bin passes
  // locally and only fails as a workspace/file: link (exit 126); twzrd-mcp-server/dist/index.js
  // lost its bit in #124 and every root `npm ci` dirtied the tree flipping it back.
  if (bins.length) {
    const { stdout } = await execFileAsync('git', ['ls-files', '-s', '--', ...bins], { cwd: dir });
    for (const bin of bins) {
      const line = stdout.split('\n').find((l) => l.endsWith(`\t${bin}`));
      if (!line) throw new Error(`${dir}/${bin}: bin is not tracked in git`);
      if (!line.startsWith('100755 ')) {
        throw new Error(`${dir}/${bin}: bin must be 100755 in git, got ${line.split(' ')[0]}`);
      }
      if (process.platform !== 'win32' && !((await stat(join(dir, bin))).mode & 0o100)) {
        throw new Error(`${dir}/${bin}: bin is not owner-executable on disk`);
      }
    }
  }
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
