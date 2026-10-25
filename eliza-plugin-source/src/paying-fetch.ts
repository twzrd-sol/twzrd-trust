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
/** Exact twzrd-x402-gate pin. A caret would float onto a later line. */
export const GATE_PIN = '0.13.1';

export function integrationTag(): string {
  return `eliza-plugin/${PLUGIN_VERSION}`;
}

/** Seat stamp: X-Twzrd-Caller eliza-plugin/<version>@<GATE_PIN>. */
export function callerTag(): string {
  return `${integrationTag()}@${GATE_PIN}`;
}

/**
 * Stamp the four seat headers on an intel fetch. The SDK's own client header
 * is replaced so the caller is this plugin, not wzrd-sdk.
 */
export function withTracking(base: typeof fetch, runId = randomUUID()): typeof fetch {
  const integration = integrationTag();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('X-TWZRD-Client', `twzrd-x402-gate/${GATE_PIN}`);
    headers.set('X-Twzrd-Caller', `${integration}@${GATE_PIN}`);
    headers.set('X-TWZRD-Integration', integration);
    headers.set('X-TWZRD-Run-Id', runId);
    return base(input, { ...init, headers });
  }) as typeof fetch;
}

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
    attribution: { integration: integrationTag(), runId: randomUUID() },
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
