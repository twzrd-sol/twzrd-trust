import { execFileSync } from 'node:child_process';
const out = execFileSync('curl', ['-fsS', 'https://intel.twzrd.xyz/v1/intel/demo-gate'], { encoding: 'utf8' });
const data = JSON.parse(out);
const block = data.steps.find((s) => s.name === 'block_path');
if (!data.ok || block?.verdict !== 'block' || block?.approved !== false || block?.signer_invocations !== 0 || data.mode !== 'no_spend') throw new Error('quickstart proof changed');
console.log('README quickstart proof verified');
