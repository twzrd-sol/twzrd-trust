import type { IAgentRuntime } from '@elizaos/core';
import { type InstallAutoGateOptions, type PayWrap } from 'twzrd-x402-gate';
/** This package's version, stamped into X-TWZRD-Integration on gate lookups. */
export declare const PLUGIN_VERSION: string;
/** Exact twzrd-x402-gate pin. A caret would float onto a later line. */
export declare const GATE_PIN = "0.14.0";
export declare function integrationTag(): string;
/** Seat stamp: X-Twzrd-Caller eliza-plugin/<version>@<GATE_PIN>. */
export declare function callerTag(): string;
/**
 * Stamp the four seat headers on an intel fetch. The SDK's own client header
 * is replaced so the caller is this plugin, not wzrd-sdk.
 */
export declare function withTracking(base: typeof fetch, runId?: `${string}-${string}-${string}-${string}-${string}`): typeof fetch;
/** Host supplies an x402-capable fetch (agentcash, twzrd-x402-gate, etc.) before runtime creation. */
export declare function setPayingFetch(f: typeof fetch): void;
/**
 * Default-on replacement for `setPayingFetch(payWrap(rawFetch))`: guards the raw fetch
 * with the free TWZRD preflight BEFORE handing it to your x402 client's `payWrap`.
 */
export declare function installTwzrdAutoGate(payWrap: PayWrap, options?: InstallAutoGateOptions): void;
/**
 * Gate options with a default run attribution, so lookups carry
 * X-TWZRD-Integration: eliza-plugin/<version>. Caller-provided attribution wins.
 */
export declare function autoGateOptions(options?: InstallAutoGateOptions): InstallAutoGateOptions;
export declare function clearPayingFetch(): void;
type FetchLike = typeof fetch;
/** Resolve paying fetch: module setter > runtime service > runtime.fetch > global fetch. */
export declare function resolvePayingFetch(runtime: IAgentRuntime): FetchLike;
export {};
