/** x402-capable fetch injection for paid intel actions. No embedded wallet. */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { IAgentRuntime } from '@elizaos/core';
import {
  installTwzrdAutoGate as buildAutoGate,
  type InstallAutoGateOptions,
  type PayWrap,
} from 'twzrd-x402-gate';

const require = createRequire(import.meta.url);
/** This package's version, stamped into X-TWZRD-Integration on gate lookups. */
export const PLUGIN_VERSION: string = (require('../package.json') as { version: string }).version;

let modulePayingFetch: typeof fetch | null = null;

/** Host supplies an x402-capable fetch (agentcash, twzrd-x402-gate, etc.) before runtime creation. */
export function setPayingFetch(f: typeof fetch): void {
  modulePayingFetch = f;
}

/**
 * Default-on replacement for `setPayingFetch(payWrap(rawFetch))`: guards the raw fetch
 * with the free TWZRD preflight BEFORE handing it to your x402 client's `payWrap`.
 */
export function installTwzrdAutoGate(payWrap: PayWrap, options?: InstallAutoGateOptions): void {
  setPayingFetch(buildAutoGate(payWrap, autoGateOptions(options)));
}

/**
 * Gate options with a default run attribution, so lookups carry
 * X-TWZRD-Integration: eliza-plugin/<version>. Caller-provided attribution wins.
 */
export function autoGateOptions(options?: InstallAutoGateOptions): InstallAutoGateOptions {
  if (options?.attribution) return options;
  return {
    ...(options ?? {}),
    attribution: { integration: `eliza-plugin/${PLUGIN_VERSION}`, runId: randomUUID() },
  };
}

export function clearPayingFetch(): void {
  modulePayingFetch = null;
}

type FetchLike = typeof fetch;

function serviceFetch(runtime: IAgentRuntime): FetchLike | null {
  for (const name of ['x402', 'payingFetch', 'agentcash']) {
    const svc = runtime.getService(name) as { fetch?: FetchLike } | null;
    if (svc?.fetch && typeof svc.fetch === 'function') return svc.fetch;
  }
  return null;
}

/** Resolve paying fetch: module setter > runtime service > runtime.fetch > global fetch. */
export function resolvePayingFetch(runtime: IAgentRuntime): FetchLike {
  if (modulePayingFetch) return modulePayingFetch;
  const fromSvc = serviceFetch(runtime);
  if (fromSvc) return fromSvc;
  if (runtime.fetch && typeof runtime.fetch === 'function') return runtime.fetch;
  return globalThis.fetch;
}
