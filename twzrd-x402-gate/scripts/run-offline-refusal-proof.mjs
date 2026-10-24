#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(process.execPath, [
  '--require', fileURLToPath(new URL('./offline-network-guard.cjs', import.meta.url)),
  '--import', 'tsx',
  fileURLToPath(new URL('../examples/offline-refusal-proof.ts', import.meta.url)),
], { stdio: 'inherit', timeout: 30_000 });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
