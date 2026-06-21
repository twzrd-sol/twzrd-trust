/**
 * End-to-end test: WZRD earn loop against live API.
 *
 * Tests: challenge → verify → infer → report(execution_id) → check rewards
 *
 * Requires: SOLANA_PRIVATE_KEY env (JSON array of secret key bytes)
 * Optional: WZRD_API_URL (defaults to https://api.twzrd.xyz)
 *
 * Run: npx tsx test/earn-e2e.ts
 */
import { Keypair } from '@solana/web3.js';
import { WzrdClient } from '../src/client.js';

const API_URL = process.env.WZRD_API_URL || 'https://api.twzrd.xyz';

async function main() {
  // --- Setup ---
  const sk = process.env.SOLANA_PRIVATE_KEY;
  if (!sk) {
    console.error('Set SOLANA_PRIVATE_KEY (JSON array of bytes) to run this test.');
    console.error('Example: export SOLANA_PRIVATE_KEY="$(cat ~/.solana/id.json)"');
    process.exit(1);
  }

  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(sk)));
  const client = new WzrdClient(kp, API_URL);
  console.log(`Agent: ${client.pubkey}`);
  console.log(`API: ${API_URL}`);
  console.log('');

  let passed = 0;
  let failed = 0;

  function assert(label: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
      failed++;
    }
  }

  // --- Step 1: Leaderboard (public, no auth) ---
  console.log('Step 1: Leaderboard (public)');
  try {
    const lb = await client.getLeaderboard(5);
    assert('returns market_count', typeof lb.market_count === 'number' && lb.market_count > 0);
    assert('returns markets array', Array.isArray(lb.markets) && lb.markets.length > 0);
    assert('markets have metric field', !!lb.markets[0].metric);
    assert('markets have velocity_ema', typeof lb.markets[0].velocity_ema === 'number');
  } catch (err) {
    assert('leaderboard fetch', false, String(err));
  }
  console.log('');

  // --- Step 2: Infer (auth required, server-witnessed) ---
  console.log('Step 2: Infer (server-witnessed)');
  let inferResult: Awaited<ReturnType<typeof client.infer>> | null = null;
  try {
    inferResult = await client.infer('What is 2 + 2? Answer with just the number.', undefined, 'reasoning');
    assert('returns execution_id', typeof inferResult.execution_id === 'string' && inferResult.execution_id.length > 0);
    assert('returns executed_model', typeof inferResult.executed_model === 'string' && inferResult.executed_model.length > 0);
    assert('returns provider', typeof inferResult.provider === 'string');
    assert('returns quality_score', typeof inferResult.quality_score === 'number' && inferResult.quality_score >= 0);
    assert('returns response_preview', typeof inferResult.response_preview === 'string' && inferResult.response_preview.length > 0);
    assert('returns latency_ms', typeof inferResult.latency_ms === 'number' && inferResult.latency_ms > 0);
    console.log(`  → Model: ${inferResult.executed_model} (${inferResult.provider})`);
    console.log(`  → Quality: ${inferResult.quality_score}, Latency: ${inferResult.latency_ms}ms`);
    console.log(`  → execution_id: ${inferResult.execution_id}`);
  } catch (err) {
    assert('infer call', false, String(err));
  }
  console.log('');

  // --- Step 3: Report (with execution_id → verified) ---
  console.log('Step 3: Report (with execution_id)');
  if (inferResult) {
    try {
      const report = await client.report({
        model_id: inferResult.requested_model,
        execution_id: inferResult.execution_id,
        task_type: 'reasoning',
        quality_score: inferResult.quality_score,
        latency_ms: inferResult.latency_ms,
      });
      assert('returns contribution_id', typeof report.contribution_id === 'number' && report.contribution_id > 0);
      assert('verification_state is verified', report.verification_state === 'verified',
        `got: ${report.verification_state}`);
      assert('pipeline_state is queued', report.pipeline_state === 'queued',
        `got: ${report.pipeline_state}`);
      assert('pending_ccm returned', typeof report.pending_ccm === 'number');
      console.log(`  → Contribution: #${report.contribution_id}`);
      console.log(`  → Verification: ${report.verification_state}`);
      console.log(`  → Pending: ${(report.pending_ccm / 1e9).toFixed(2)} CCM`);
    } catch (err) {
      assert('report call', false, String(err));
    }
  } else {
    console.log('  (skipped — infer failed)');
  }
  console.log('');

  // --- Step 4: Check Rewards ---
  console.log('Step 4: Check Rewards');
  try {
    const rewards = await client.getRewards();
    assert('returns pending_ccm', typeof rewards.pending_ccm === 'number');
    assert('returns total_rewarded_ccm', typeof rewards.total_rewarded_ccm === 'number');
    assert('returns contribution_count', typeof rewards.contribution_count === 'number');
    console.log(`  → Pending: ${(rewards.pending_ccm / 1e9).toFixed(2)} CCM`);
    console.log(`  → Lifetime: ${(rewards.total_rewarded_ccm / 1e9).toFixed(2)} CCM`);
    console.log(`  → Contributions: ${rewards.contribution_count}`);
  } catch (err) {
    assert('rewards check', false, String(err));
  }
  console.log('');

  // --- Step 5: Claim Status ---
  console.log('Step 5: Claim Status');
  try {
    const status = await client.getClaimStatus();
    assert('returns cumulative_total', typeof status.cumulative_total === 'number');
    assert('returns claimed_total', typeof status.claimed_total === 'number');
    assert('returns claimable', typeof status.claimable === 'number');
    console.log(`  → Cumulative: ${(status.cumulative_total / 1e9).toFixed(2)} CCM`);
    console.log(`  → Claimed: ${(status.claimed_total / 1e9).toFixed(2)} CCM`);
    console.log(`  → Claimable: ${(status.claimable / 1e9).toFixed(2)} CCM`);
  } catch (err) {
    assert('claim status', false, String(err));
  }
  console.log('');

  // --- Summary ---
  console.log('═══════════════════════════════════════');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
