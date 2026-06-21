/**
 * Standalone WZRD API client for ElizaOS agents.
 * No external dependencies beyond @solana/web3.js for Ed25519 signing.
 *
 * Auth flow: challenge → sign → verify → Bearer token (24h TTL)
 * Earn flow: infer → report(execution_id) → claim
 */
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const DEFAULT_API = 'https://api.twzrd.xyz';

export interface InferResult {
  execution_id: string;
  executed_model: string;
  requested_model: string;
  provider: string;
  quality_score: number;
  response_preview: string;
  latency_ms: number;
  cost_usd?: number;
}

export interface ReportResult {
  contribution_id: number;
  verification_state: string;
  lifetime_contributions: number;
  pending_ccm: number;
  pipeline_state: string;
  idempotent: boolean;
  provider_receipt_present: boolean;
}

export interface RewardsBalance {
  pending_ccm: number;
  total_rewarded_ccm: number;
  rank: number | null;
  contribution_count: number;
}

export interface ClaimResult {
  tx_sig: string | null;
  root_seq: number;
  cumulative_total: number;
  status: string;
}

export interface LeaderboardResult {
  market_count: number;
  total_tvl: number;
  root: { root_seq: number };
  markets: Array<{
    market_id: number;
    metric: string;
    platform: string;
    velocity_ema: number;
    multiplier_bps: number;
    snapshot_count: number;
  }>;
}

export class WzrdClient {
  private keypair: Keypair;
  private apiUrl: string;
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(keypair: Keypair, apiUrl?: string) {
    this.keypair = keypair;
    this.apiUrl = apiUrl || DEFAULT_API;
  }

  get pubkey(): string {
    return this.keypair.publicKey.toBase58();
  }

  /** Ed25519 challenge → sign → verify → Bearer token */
  private async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;

    // 1. Get challenge
    const challengeRes = await fetch(`${this.apiUrl}/v1/agent/challenge`);
    if (!challengeRes.ok) throw new Error(`Challenge failed: ${challengeRes.status}`);
    const { nonce } = await challengeRes.json() as { nonce: string };

    // 2. Construct message locally (must match server's agent_auth_message format)
    const message = `wzrd-agent-auth v1 | wallet:${this.pubkey} | nonce:${nonce}`;
    const messageBytes = new TextEncoder().encode(message);
    const signature = nacl.sign.detached(messageBytes, this.keypair.secretKey);

    // 3. Verify — signature must be base58-encoded (Solana Signature format)
    const verifyRes = await fetch(`${this.apiUrl}/v1/agent/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubkey: this.pubkey,
        nonce,
        signature: bs58.encode(signature),
      }),
    });
    if (!verifyRes.ok) throw new Error(`Verify failed: ${verifyRes.status}`);
    const { token } = await verifyRes.json() as { token: string };

    this.token = token;
    this.tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // refresh 1h before 24h expiry
    return token;
  }

  /** Authenticated fetch helper */
  private async authedFetch(path: string, init?: RequestInit): Promise<Response> {
    const token = await this.authenticate();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Content-Type', 'application/json');
    return fetch(`${this.apiUrl}${path}`, { ...init, headers });
  }

  /** Pick a model from the momentum signal — returns top model's channel_id */
  async pickModel(taskType?: string): Promise<string> {
    const res = await fetch(`${this.apiUrl}/v1/signals/momentum?limit=10&trending=true`);
    if (!res.ok) throw new Error(`Momentum fetch failed: ${res.status}`);
    const data = await res.json() as { models: Array<{ model: string; platform: string; trend: string }> };
    if (!data.models?.length) throw new Error('No models available in momentum feed');
    // Return the top-ranked model's channel_id (e.g. "moonshotai/Kimi-K2.5")
    return data.models[0].model;
  }

  /** Server-witnessed inference — WZRD calls the provider, grades quality */
  async infer(prompt: string, model?: string, taskType?: string): Promise<InferResult> {
    const resolvedModel = model || await this.pickModel(taskType);
    const res = await this.authedFetch('/v1/agent/infer', {
      method: 'POST',
      body: JSON.stringify({ model: resolvedModel, prompt, task_type: taskType || 'chat' }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Infer failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<InferResult>;
  }

  /** Report model pick with execution_id for verified rewards */
  async report(params: {
    model_id: string;
    execution_id: string;
    task_type?: string;
    quality_score?: number;
    latency_ms?: number;
  }): Promise<ReportResult> {
    const res = await this.authedFetch('/v1/agent/report', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Report failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<ReportResult>;
  }

  /** Check pending + total rewards (flattens nested /v1/agent/earned response) */
  async getRewards(): Promise<RewardsBalance> {
    const res = await this.authedFetch('/v1/agent/earned');
    if (!res.ok) throw new Error(`Rewards check failed: ${res.status}`);
    const data = await res.json() as Record<string, unknown>;
    const economy = data.economy as Record<string, unknown> | undefined;
    const routing = data.routing as Record<string, unknown> | undefined;
    return {
      pending_ccm: Number(economy?.pending_ccm ?? 0),
      total_rewarded_ccm: Number(economy?.earned_ccm ?? 0),
      rank: null, // rank not in this endpoint
      contribution_count: Number(routing?.lifetime_contributions ?? 0),
    };
  }

  /** Gasless CCM claim via server relay */
  async claimRelay(): Promise<ClaimResult> {
    const res = await this.authedFetch(`/v1/claims/${this.pubkey}/relay`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Claim relay failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<ClaimResult>;
  }

  /** Public: fetch leaderboard (no auth) */
  async getLeaderboard(limit = 20): Promise<LeaderboardResult> {
    const res = await fetch(`${this.apiUrl}/v1/leaderboard?limit=${limit}`);
    if (!res.ok) throw new Error(`Leaderboard failed: ${res.status}`);
    return res.json() as Promise<LeaderboardResult>;
  }

  /** Public: fetch claims status */
  async getClaimStatus(): Promise<{ cumulative_total: number; claimed_total: number; claimable: number }> {
    const res = await this.authedFetch(`/v1/claims/${this.pubkey}`);
    if (!res.ok) {
      if (res.status === 404) return { cumulative_total: 0, claimed_total: 0, claimable: 0 };
      throw new Error(`Claim status failed: ${res.status}`);
    }
    const data = await res.json() as { cumulative_total: number; claimed_total: number };
    return { ...data, claimable: data.cumulative_total - data.claimed_total };
  }
}

// Thin wrappers delegating to @wzrd_sol/sdk intel surface (preflight/trust/verify) per plan.
// Kept in client.ts alongside earn WzrdClient. Actual runtime client for intel is via getIntelClient() in factory.
export {
  intelPreflight as intelPreflightClient,
  fetchIntelTrust as fetchIntelTrustClient,
  verifyReceipt as verifyReceiptClient,
} from '@wzrd_sol/sdk';
