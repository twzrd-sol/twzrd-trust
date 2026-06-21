import {
  IntelPaymentRequiredError,
  intelTrustUrl,
  type PreflightInput,
  type TwzrdReceipt,
} from '@wzrd_sol/sdk';

const DEFAULT_INTEL = 'https://intel.twzrd.xyz';

export function getIntelBase(runtime: { getSetting: (k: string) => string | boolean | number | null }): string {
  const url = runtime.getSetting('WZRD_INTEL_URL');
  return typeof url === 'string' && url.length > 0 ? url : DEFAULT_INTEL;
}

/** Pull structured fields from Eliza message content (flat or JSON-in-text). */
export function parsePreflightInput(content: Record<string, unknown>): PreflightInput {
  const direct: PreflightInput = {
    resource_name: str(content.resource_name),
    seller_wallet: str(content.seller_wallet ?? content.pubkey ?? content.wallet),
    resource_url: str(content.resource_url ?? content.url),
    price_usdc: num(content.price_usdc ?? content.price),
    buyer_wallet: str(content.buyer_wallet),
    agent_intent: str(content.agent_intent ?? content.intent),
    marketplace_score: num(content.marketplace_score),
  };

  const text = str(content.text);
  if (text) {
    const fromJson = tryParseJson(text);
    if (fromJson) return { ...direct, ...pickPreflight(fromJson) };
    const wallet = extractWallet(text);
    if (wallet && !direct.seller_wallet) direct.seller_wallet = wallet;
    if (!direct.agent_intent) direct.agent_intent = text;
  }

  return compactPreflight(direct);
}

export function parseReceipt(content: Record<string, unknown>): TwzrdReceipt | null {
  if (content.receipt && typeof content.receipt === 'object') {
    return content.receipt as TwzrdReceipt;
  }
  const text = str(content.text);
  if (!text) return null;
  const parsed = tryParseJson(text);
  if (parsed && typeof parsed === 'object' && 'leaf' in parsed && 'preimage' in parsed) {
    return parsed as unknown as TwzrdReceipt;
  }
  return null;
}

export function extractPubkey(content: Record<string, unknown>): string | null {
  const direct = str(content.pubkey ?? content.seller_wallet ?? content.wallet);
  if (direct) return direct;
  const text = str(content.text);
  if (!text) return null;
  const fromJson = tryParseJson(text);
  if (fromJson) {
    const w = str(fromJson.pubkey ?? fromJson.seller_wallet ?? fromJson.wallet);
    if (w) return w;
  }
  return extractWallet(text);
}

export function formatPaymentRequired(err: IntelPaymentRequiredError, apiBase: string, pubkey: string): string {
  const url = intelTrustUrl(pubkey, apiBase);
  const reqs = err.paymentRequirements;
  const accepts =
    reqs && typeof reqs === 'object' && 'accepts' in reqs && Array.isArray((reqs as { accepts: unknown }).accepts)
      ? (reqs as { accepts: { amount?: string; payTo?: string; network?: string }[] }).accepts[0]
      : null;
  const amount = accepts?.amount ?? '50000';
  const payTo = accepts?.payTo ?? '(see accepts)';
  const network = accepts?.network ?? 'solana';

  return (
    `Intel trust requires x402 payment (~0.05 USDC).\n` +
    `Endpoint: ${url}\n` +
    `Network: ${network}, amount (atomic): ${amount}, payTo: ${payTo}\n\n` +
    `No paying fetch configured. Wire one before runtime creation:\n` +
    `  import { setPayingFetch } from '@wzrd_sol/eliza-plugin';\n` +
    `  setPayingFetch(myAgentcashFetch);\n\n` +
    `Or pay out of band:\n` +
    `  npx agentcash@latest fetch ${url}`
  );
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const v = JSON.parse(trimmed) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractWallet(text: string): string | null {
  const m = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  return m ? m[0] : null;
}

function pickPreflight(obj: Record<string, unknown>): PreflightInput {
  return compactPreflight({
    resource_name: str(obj.resource_name),
    seller_wallet: str(obj.seller_wallet ?? obj.pubkey ?? obj.wallet),
    resource_url: str(obj.resource_url ?? obj.url),
    price_usdc: num(obj.price_usdc ?? obj.price),
    buyer_wallet: str(obj.buyer_wallet),
    agent_intent: str(obj.agent_intent ?? obj.intent),
    marketplace_score: num(obj.marketplace_score),
  });
}

function compactPreflight(input: PreflightInput): PreflightInput {
  const out: PreflightInput = {};
  if (input.resource_name) out.resource_name = input.resource_name;
  if (input.seller_wallet) out.seller_wallet = input.seller_wallet;
  if (input.resource_url) out.resource_url = input.resource_url;
  if (input.price_usdc !== undefined) out.price_usdc = input.price_usdc;
  if (input.buyer_wallet) out.buyer_wallet = input.buyer_wallet;
  if (input.agent_intent) out.agent_intent = input.agent_intent;
  if (input.marketplace_score !== undefined) out.marketplace_score = input.marketplace_score;
  return out;
}

/**
 * Timeout wrapper for SDK network calls (preflight/trust/verify).
 * Supports two call forms for minimal change:
 * - withTimeout(promise) for preflight (SDK does not expose fetchImpl/signal)
 * - withTimeout((signal) => sdkCallWithFetchImpl(abortingFetch)) for trust/verify
 * Uses AbortController + signal: abort() is called on timeout so that when caller
 * wires the returned signal into fetchImpl, the underlying network request is aborted.
 * Always clears timer in finally (no leak). Attaches rejection observer to the
 * call promise (without altering settlement) to avoid unhandled rejections on the
 * loser of the race.
 * Applied to actions + getIntelClient delegates.
 */
export function withTimeout<T>(
  pOrMake: Promise<T> | ((signal?: AbortSignal) => Promise<T>),
  ms = 8000
): Promise<T> {
  if (typeof pOrMake === 'function') {
    const makeCall = pOrMake;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, ms);
    });
    const callP = makeCall(controller.signal);
    // Observe rejections on callP so a late rejection after timeout does not emit unhandledrejection.
    callP.then(undefined, () => {});
    return Promise.race([callP, timeoutP]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }) as Promise<T>;
  }
  // legacy path (promise passed directly): still safe timeout + no unhandled + clear
  const p = pOrMake;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, ms);
  });
  p.then(undefined, () => {});
  return Promise.race([p, timeoutP]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
