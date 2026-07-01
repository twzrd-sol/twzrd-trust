import nacl from 'tweetnacl';
import bs58 from 'bs58';
const DEFAULT_API = 'https://api.twzrd.xyz';
export class WzrdClient {
    keypair;
    apiUrl;
    token = null;
    tokenExpiry = 0;
    constructor(keypair, apiUrl) {
        this.keypair = keypair;
        this.apiUrl = apiUrl || DEFAULT_API;
    }
    get pubkey() {
        return this.keypair.publicKey.toBase58();
    }
    /** Ed25519 challenge → sign → verify → Bearer token */
    async authenticate() {
        if (this.token && Date.now() < this.tokenExpiry)
            return this.token;
        // 1. Get challenge
        const challengeRes = await fetch(`${this.apiUrl}/v1/agent/challenge`);
        if (!challengeRes.ok)
            throw new Error(`Challenge failed: ${challengeRes.status}`);
        const { nonce } = await challengeRes.json();
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
        if (!verifyRes.ok)
            throw new Error(`Verify failed: ${verifyRes.status}`);
        const { token } = await verifyRes.json();
        this.token = token;
        this.tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // refresh 1h before 24h expiry
        return token;
    }
    /** Authenticated fetch helper */
    async authedFetch(path, init) {
        const token = await this.authenticate();
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${token}`);
        headers.set('Content-Type', 'application/json');
        return fetch(`${this.apiUrl}${path}`, { ...init, headers });
    }
    /** Pick a model from the momentum signal — returns top model's channel_id */
    async pickModel(taskType) {
        const res = await fetch(`${this.apiUrl}/v1/signals/momentum?limit=10&trending=true`);
        if (!res.ok)
            throw new Error(`Momentum fetch failed: ${res.status}`);
        const data = await res.json();
        if (!data.models?.length)
            throw new Error('No models available in momentum feed');
        // Return the top-ranked model's channel_id (e.g. "moonshotai/Kimi-K2.5")
        return data.models[0].model;
    }
    /** Server-witnessed inference — WZRD calls the provider, grades quality */
    async infer(prompt, model, taskType) {
        const resolvedModel = model || await this.pickModel(taskType);
        const res = await this.authedFetch('/v1/agent/infer', {
            method: 'POST',
            body: JSON.stringify({ model: resolvedModel, prompt, task_type: taskType || 'chat' }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Infer failed (${res.status}): ${body}`);
        }
        return res.json();
    }
    /** Report model pick with execution_id for verified rewards */
    async report(params) {
        const res = await this.authedFetch('/v1/agent/report', {
            method: 'POST',
            body: JSON.stringify(params),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Report failed (${res.status}): ${body}`);
        }
        return res.json();
    }
    /** Check pending + total rewards (reads flat /v1/agent/earned response) */
    async getRewards() {
        const res = await this.authedFetch('/v1/agent/earned');
        if (!res.ok)
            throw new Error(`Rewards check failed: ${res.status}`);
        const data = await res.json();
        return {
            pending_ccm: Number(data.pending_ccm ?? 0),
            total_rewarded_ccm: Number(data.total_earned_ccm ?? 0),
            rank: data.rank == null ? null : Number(data.rank),
            contribution_count: Number(data.lifetime_contributions ?? 0),
        };
    }
    /** Gasless CCM claim via server relay */
    async claimRelay() {
        const res = await this.authedFetch(`/v1/claims/${this.pubkey}/relay`, {
            method: 'POST',
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Claim relay failed (${res.status}): ${body}`);
        }
        return res.json();
    }
    /** Public: fetch leaderboard (no auth) */
    async getLeaderboard(limit = 20) {
        const res = await fetch(`${this.apiUrl}/v1/leaderboard?limit=${limit}`);
        if (!res.ok)
            throw new Error(`Leaderboard failed: ${res.status}`);
        return res.json();
    }
    /** Public: fetch claims status */
    async getClaimStatus() {
        const res = await this.authedFetch(`/v1/claims/${this.pubkey}`);
        if (!res.ok) {
            if (res.status === 404)
                return { cumulative_total: 0, claimed_total: 0, claimable: 0 };
            throw new Error(`Claim status failed: ${res.status}`);
        }
        const data = await res.json();
        return { ...data, claimable: data.cumulative_total - data.claimed_total };
    }
}
// Thin wrappers delegating to @wzrd_sol/sdk intel surface (preflight/trust/verify) per plan.
// Kept in client.ts alongside earn WzrdClient. Actual runtime client for intel is via getIntelClient() in factory.
export { intelPreflight as intelPreflightClient, fetchIntelTrust as fetchIntelTrustClient, verifyReceipt as verifyReceiptClient, } from '@wzrd_sol/sdk';
