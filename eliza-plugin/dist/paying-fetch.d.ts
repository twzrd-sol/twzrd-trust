/** x402-capable fetch injection for paid intel actions. No embedded wallet. */
import type { IAgentRuntime } from '@elizaos/core';
import { type InstallAutoGateOptions, type PayWrap } from 'twzrd-x402-gate';
/** Host supplies an x402-capable fetch (agentcash, twzrd-x402-gate, etc.) before runtime creation. */
export declare function setPayingFetch(f: typeof fetch): void;
/**
 * Default-on replacement for `setPayingFetch(payWrap(rawFetch))`: guards the raw fetch
 * with the free TWZRD preflight BEFORE handing it to your x402 client's `payWrap`, so a
 * blocked seller is refused before your client ever signs — then registers the result as
 * the module paying fetch (same slot `setPayingFetch` writes to).
 *
 * Opt out with `TWZRD_AUTO_GATE=0` (env) or `{ disabled: true }`.
 *
 * @example
 *   import { installTwzrdAutoGate } from '@wzrd_sol/eliza-plugin';
 *   import { wrapFetchWithPayment } from '@x402/svm';
 *
 *   installTwzrdAutoGate((guarded) => wrapFetchWithPayment(guarded, buyerWallet));
 *   const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
 */
export declare function installTwzrdAutoGate(payWrap: PayWrap, options?: InstallAutoGateOptions): void;
export declare function clearPayingFetch(): void;
type FetchLike = typeof fetch;
/** Resolve paying fetch: module setter > runtime service > runtime.fetch > global fetch. */
export declare function resolvePayingFetch(runtime: IAgentRuntime): FetchLike;
export {};
