/** x402-capable fetch injection for paid intel actions. No embedded wallet. */
import type { IAgentRuntime } from '@elizaos/core';
/** Host supplies an x402-capable fetch (agentcash, twzrd-x402-gate, etc.) before runtime creation. */
export declare function setPayingFetch(f: typeof fetch): void;
export declare function clearPayingFetch(): void;
type FetchLike = typeof fetch;
/** Resolve paying fetch: module setter > runtime service > runtime.fetch > global fetch. */
export declare function resolvePayingFetch(runtime: IAgentRuntime): FetchLike;
export {};
