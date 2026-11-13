/**
 * Edge-safe Base x402 preflight gate.
 *
 * This module is intentionally standalone: it imports no package code and uses
 * only Fetch/Web-standard APIs, so Workers can import `twzrd-x402-gate/cloudflare-base`
 * without bringing Node modules or Solana adapters into their bundle.
 *
 * `.kill` / `.pause`: the module also runs under Node (tests, a local agent, a
 * server that signs Base payments), and there it is a signing seat like any
 * other, so it reads the two sentinel files itself: on entry, and again in the
 * same synchronous step as the go-ahead. The reader below restates the main
 * entry's rules and reaches the filesystem without an import statement, so the
 * Worker bundle is unchanged. In a Worker there is no host filesystem for a
 * file to be dropped on, and nothing is read.
 */

export const BASE_CHAIN_ID = 8453;
export const BASE_NETWORK = `eip155:${BASE_CHAIN_ID}`;

export type CloudflareBaseRequirements = {
  resource?: string;
  accepts?: Array<Record<string, unknown>>;
};

export type BasePreflightVerdict = {
  decision: "allow" | "warn" | "block";
  /** TWZRD's current preflight calls this trust_score; normalized here for callers. */
  riskScore: number | null;
  reasons: string[];
  /** Free preflight fields the signing rules below read (0.11.2). */
  nullReason?: string | null;
  scoreIsNull?: boolean;
  recommendedCapUsdc?: number | null;
  washFlagged?: boolean | null;
};

/** Base mainnet USDC. The only asset this module signs for. */
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export type CloudflareBaseGateOptions = {
  intelBase?: string;
  fetch?: typeof fetch;
  /**
   * Ignored for the signing decision since 0.11.2: the price is read from the
   * Base USDC entry's own `amount`, so a caller cannot understate it.
   * @deprecated
   */
  priceUsdc?: number;
  /** Refuse an evaluated seller scoring below this (default 40, same as the package). */
  preflightMinScore?: number;
  /** Refuse every seller intel has never evaluated (same as the package option). */
  refuseUnevaluated?: boolean;
  resourceName?: string;
  agentIntent?: string;
  /** Default false: an unavailable or malformed preflight does not permit signing. */
  failOpen?: boolean;
  /** Deadline for the preflight call, ms (default 2000). A miss is an outage decided by failOpen. */
  intelTimeoutMs?: number;
  /**
   * Where the `.kill` / `.pause` sentinels live when this module runs on a host
   * with a filesystem. Defaults: TWZRD_STATE_DIR (else `./data`),
   * KILLSWITCH_KILL_FILE, KILLSWITCH_PAUSE_FILE; a blank value counts as unset.
   * `failOpen` does not skip this read. Not read in a Worker.
   */
  stateDir?: string;
  killFilePath?: string;
  pauseFilePath?: string;
};

const TRUE_FLAGS = new Set(["true", "1", "yes", "on"]);
/** Same reading as the main entry's isTrueFlag (kept local: this module imports no package code). */
function isTrueFlag(v: unknown): boolean {
  if (v === true || v === 1) return true;
  return typeof v === "string" && TRUE_FLAGS.has(v.trim().toLowerCase());
}

const DEFAULT_INTEL_TIMEOUT_MS = 2000;

export class TwzrdBasePaymentBlockedError extends Error {
  readonly verdict: BasePreflightVerdict;

  constructor(verdict: BasePreflightVerdict) {
    super(`[twzrd] Base payment blocked: ${verdict.reasons.join(",") || "PREFLIGHT_BLOCK"}`);
    this.name = "TwzrdBasePaymentBlockedError";
    this.verdict = verdict;
  }
}

/* ------------------------------------------------------------------ */
/* `.kill` / `.pause` on a host with a filesystem                       */
/* ------------------------------------------------------------------ */

type HostFs = {
  statSync(path: string): unknown;
  readFileSync(path: string, encoding: "utf8"): string;
};
type HostProcess = {
  versions?: { node?: string };
  env?: Record<string, string | undefined>;
  getBuiltinModule?: (id: string) => unknown;
};
type HostGlobals = { process?: HostProcess; navigator?: { userAgent?: string } };

/** Same literal as the main entry's PAUSE_SENTINEL_SCHEMA (kept local: this module imports no package code). */
const PAUSE_SENTINEL_SCHEMA = "twzrd.pause_sentinel.v1";

/** undefined: not looked up yet. null: this runtime has no host filesystem. */
let hostFs: HostFs | null | undefined;

/**
 * The host's `fs`, or null where there is none. A Worker reports
 * `navigator.userAgent === "Cloudflare-Workers"`; with `nodejs_compat` it also
 * has a `process` and a virtual in-memory `fs` that no operator can drop a
 * file on, so it is ruled out by name rather than probed.
 */
async function loadHostFs(): Promise<HostFs | null> {
  if (hostFs !== undefined) return hostFs;
  const host = globalThis as HostGlobals;
  if (host.navigator?.userAgent === "Cloudflare-Workers" || typeof host.process?.versions?.node !== "string") {
    return (hostFs = null);
  }
  try {
    const builtin = host.process.getBuiltinModule?.("node:fs") as HostFs | undefined;
    if (builtin && typeof builtin.statSync === "function") return (hostFs = builtin);
  } catch {
    /* older Node: fall through to the dynamic import */
  }
  try {
    // Not a literal, so a Worker bundler has nothing to resolve.
    const specifier = ["node", "fs"].join(":");
    const loaded = (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as HostFs;
    return (hostFs = typeof loaded.statSync === "function" ? loaded : null);
  } catch {
    // No loadable `fs` means no filesystem a sentinel file could be on.
    return (hostFs = null);
  }
}

function pathSetting(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return undefined;
}

type BaseHalt = { code: "twzrd_kill_switch" | "twzrd_pause_corrupt" | "twzrd_payment_paused"; detail?: string };

/** Same rules as the main entry's readSentinelState: any error but "no such file" is a halt. */
function readHalt(fs: HostFs, options: CloudflareBaseGateOptions): BaseHalt | undefined {
  const env = (globalThis as HostGlobals).process?.env ?? {};
  const stateDir = pathSetting(options.stateDir, env.TWZRD_STATE_DIR) ?? "./data";
  // No `node:path` here: `/` joins on every platform Node's fs runs on.
  const inStateDir = (name: string) => `${stateDir}${/[\\/]$/.test(stateDir) ? "" : "/"}${name}`;
  const killPath = pathSetting(options.killFilePath, env.KILLSWITCH_KILL_FILE) ?? inStateDir(".kill");
  const pausePath = pathSetting(options.pauseFilePath, env.KILLSWITCH_PAUSE_FILE) ?? inStateDir(".pause");

  try {
    fs.statSync(killPath);
    return { code: "twzrd_kill_switch" };
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "ENOENT") return { code: "twzrd_kill_switch" };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(pausePath, "utf8");
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ENOENT") return undefined;
    return { code: "twzrd_pause_corrupt" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: "twzrd_pause_corrupt" };
  }
  const pause = asRecord(parsed);
  if (!pause) return { code: "twzrd_pause_corrupt" };
  if ("schema" in pause && pause.schema !== PAUSE_SENTINEL_SCHEMA) return { code: "twzrd_pause_corrupt" };
  const until = pause.until_unix_ms;
  if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) return { code: "twzrd_pause_corrupt" };
  if (Date.now() >= until) return undefined;
  const detail = typeof pause.reason === "string" && pause.reason.trim() !== "" ? pause.reason.trim() : "payment_gate_halt";
  return { code: "twzrd_payment_paused", detail };
}

/**
 * Awaited once on entry. The function it returns is synchronous, so the last
 * read and the go-ahead that follows it share one step.
 */
async function sentinelReader(options: CloudflareBaseGateOptions): Promise<() => BaseHalt | undefined> {
  const fs = await loadHostFs();
  return fs === null ? () => undefined : () => readHalt(fs, options);
}

function haltedError(halt: BaseHalt): TwzrdBasePaymentBlockedError {
  return new TwzrdBasePaymentBlockedError({
    decision: "block",
    riskScore: null,
    reasons: halt.detail ? [halt.code, halt.detail] : [halt.code],
  });
}

/**
 * Calls the live TWZRD preflight with an exact Base mainnet payTo.
 *
 * Both lowercase and checksummed EVM addresses are valid inputs. The address is
 * preserved as received; the endpoint evaluates the exact recipient the client
 * is about to authorize.
 */
export async function twzrdBasePreflight(
  requirements: CloudflareBaseRequirements,
  options: CloudflareBaseGateOptions = {},
): Promise<BasePreflightVerdict> {
  const { payTo, priceUsdc } = baseOffer(requirements);
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("[twzrd] Worker fetch is unavailable");

  const intelBase = (options.intelBase ?? "https://intel.twzrd.xyz").replace(/\/+$/, "");
  const t = Number(options.intelTimeoutMs);
  const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, 2_147_483_647) : DEFAULT_INTEL_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`[twzrd] Base preflight timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const call = (async () => {
  const response = await fetchFn(`${intelBase}/v1/intel/preflight`, {
    signal: ctrl.signal,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resource_name: options.resourceName ?? requirements.resource ?? "cloudflare_base_x402",
      resource_url: requirements.resource,
      seller_wallet: payTo,
      price_usdc: priceUsdc,
      agent_intent: options.agentIntent ?? "cloudflare_base_x402_preflight",
      chain: "base",
      chain_id: BASE_CHAIN_ID,
    }),
  });
  if (!response.ok) throw new Error(`[twzrd] Base preflight HTTP ${response.status}`);
  return normalizePreflight(await response.json());
  })();
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
    call.catch(() => {});
  }
}


/** v1 names for Solana clusters. With any CAIP-2 namespace other than eip155, the rails an EVM signer cannot pay. */
const SOLANA_V1_NETWORKS = new Set(["solana", "solana-mainnet", "solana-mainnet-beta", "solana-devnet", "solana-testnet"]);

/**
 * What an accepts[] entry is to this seat:
 *  - "base": a Base entry, by network name or chain id, read case- and
 *    whitespace-insensitively ("BASE", "eip155:8453 ") so a spelling variant
 *    is scored, not skipped. When both a network and a chain id are given,
 *    both must say Base.
 *  - "not_evm": an entry on a rail the EVM signer behind this seat cannot pay
 *    (Solana, or another non-eip155 CAIP-2 namespace). Not its to sign and
 *    deliberately not scored here (0.11.4).
 *  - "unvetted": everything else. Another EVM chain, a network this module
 *    cannot place, no network at all, a mistyped field, a non-object. The
 *    client behind this seat signs any EVM entry and picks the first one it
 *    can pay, and nothing here scores an entry that is not Base.
 */
type EntryRail = "base" | "not_evm" | "unvetted";

function entryRail(candidate: unknown): EntryRail {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return "unvetted";
  const c = candidate as Record<string, unknown>;
  if (c.network != null && typeof c.network !== "string") return "unvetted";
  const network = typeof c.network === "string" ? c.network.trim().toLowerCase() : "";
  const chainId = c.chainId ?? c.chain_id;
  const chain = typeof chainId === "string" ? chainId.trim() : chainId;
  const chainNamed = chain != null && chain !== "";
  const chainIsBase = chain === BASE_CHAIN_ID || chain === String(BASE_CHAIN_ID);
  if (network === "") return chainIsBase ? "base" : "unvetted";
  if (network === BASE_NETWORK || network === "base" || network === "base-mainnet") {
    return !chainNamed || chainIsBase ? "base" : "unvetted";
  }
  // A chain id is an EVM field: on a network that is not Base it names another
  // chain, or contradicts the network. Neither is scored.
  if (chainNamed) return "unvetted";
  const colon = network.indexOf(":");
  const notEvm = colon > 0 ? network.slice(0, colon) !== "eip155" : SOLANA_V1_NETWORKS.has(network);
  return notEvm ? "not_evm" : "unvetted";
}

function isBaseEntry(candidate: unknown): candidate is Record<string, unknown> {
  return entryRail(candidate) === "base";
}

/**
 * One requirements object per Base entry, so every entry the Worker could sign
 * is evaluated (0.11.3). An entry that is neither Base nor on a rail the EVM
 * signer cannot pay refuses the whole 402: approving it on the strength of a
 * Base sibling let the client sign the entry nobody scored.
 */
function perBaseEntry(requirements: CloudflareBaseRequirements): CloudflareBaseRequirements[] {
  const accepts: unknown[] = Array.isArray(requirements.accepts) ? requirements.accepts : [];
  const base: Array<Record<string, unknown>> = [];
  for (const entry of accepts) {
    const rail = entryRail(entry);
    if (rail === "unvetted") {
      throw new OfferRefusal("unvetted_payment_option", "[twzrd] the 402 lists an offer that is not Base and that an EVM signer could pay");
    }
    if (rail === "base") base.push(entry as Record<string, unknown>);
  }
  if (base.length === 0) return [requirements];
  if (base.length > 8) throw new OfferRefusal("too_many_payment_options", "[twzrd] more than 8 Base offers");
  return base.map((entry) => ({ ...requirements, accepts: [entry] }));
}

/** Cloudflare `withX402Client` callback: true permits the retry; false aborts it. */
export function createTwzrdCloudflareBaseApproval(
  options: CloudflareBaseGateOptions = {},
): (requirements: CloudflareBaseRequirements) => Promise<boolean> {
  return async (requirements) => {
    const halt = await sentinelReader(options);
    if (halt() !== undefined) return false;
    let entries: CloudflareBaseRequirements[];
    const offers: Array<{ payTo: string; priceUsdc: number }> = [];
    try {
      entries = perBaseEntry(requirements);
      for (const e of entries) offers.push(baseOffer(e));
    } catch {
      // A malformed or non-USDC offer is not an outage: failOpen never signs it.
      return false;
    }
    try {
      for (let i = 0; i < entries.length; i++) {
        const verdict = await twzrdBasePreflight(entries[i], options);
        if (baseRefusal(verdict, offers[i].priceUsdc, options) !== undefined) return false;
      }
      // The preflight was awaited: read again as the approval is returned.
      return halt() === undefined;
    } catch {
      // failOpen waves an intel outage through. It does not wave a halt through.
      return isTrueFlag(options.failOpen) && halt() === undefined;
    }
  };
}

/**
 * Minimal signing interceptor for a Worker or Viem account. The callback is
 * invoked only when the Base USDC offer passes the package's signing rules:
 * not blocked, not wash-flagged, a never-evaluated seller within its cap, an
 * evaluated seller at or above the score floor and within its cap (0.11.2).
 */
export async function withTwzrdBasePreflight<T>(
  requirements: CloudflareBaseRequirements,
  options: CloudflareBaseGateOptions,
  signOrSend: () => Promise<T>,
): Promise<T> {
  const halt = await sentinelReader(options);
  const refuseIfHalted = (): void => {
    const halted = halt();
    if (halted) throw haltedError(halted);
  };
  refuseIfHalted();
  // Offer shape first: a malformed amount or non-USDC asset is refused before
  // intel and is never an outage for failOpen to wave through (0.11.2).
  let entries: CloudflareBaseRequirements[];
  const offers: Array<{ payTo: string; priceUsdc: number }> = [];
  try {
    entries = perBaseEntry(requirements);
    for (const e of entries) offers.push(baseOffer(e));
  } catch (error) {
    throw new TwzrdBasePaymentBlockedError({
      decision: "block",
      riskScore: null,
      reasons: [refusalCode(error)],
    });
  }
  for (let i = 0; i < entries.length; i++) {
    let verdict: BasePreflightVerdict;
    try {
      verdict = await twzrdBasePreflight(entries[i], options);
    } catch (error) {
      if (isTrueFlag(options.failOpen)) {
        // failOpen waves an intel outage through. It does not wave a halt through.
        refuseIfHalted();
        return signOrSend();
      }
      throw error;
    }
    const refusal = baseRefusal(verdict, offers[i].priceUsdc, options);
    if (refusal) {
      throw new TwzrdBasePaymentBlockedError({ ...verdict, reasons: [refusal, ...verdict.reasons] });
    }
  }
  // Last look: nothing is awaited between this read and the signer.
  refuseIfHalted();
  return signOrSend();
}

class OfferRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function refusalCode(error: unknown): string {
  return error instanceof OfferRefusal ? error.code : "invalid_base_offer";
}

/**
 * The Base entry the Worker will sign, with its price. Same rules as the rest
 * of the package, restated here because this module imports nothing:
 * the amount is an ASCII base-unit integer, the asset is Base USDC (or unnamed,
 * which the exact EVM scheme resolves to USDC), and v1/v2 duplicates agree.
 */
function baseOffer(requirements: CloudflareBaseRequirements): { payTo: string; priceUsdc: number } {
  const accepts = Array.isArray(requirements.accepts) ? requirements.accepts : [];
  const accept = accepts.find((candidate) => isBaseEntry(candidate));
  const payTo = accept?.payTo ?? accept?.pay_to;
  if (typeof payTo !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
    throw new OfferRefusal("twzrd_unidentifiable_payment_recipient", "[twzrd] Base x402 requirements lack a valid eip155:8453 payTo");
  }
  const a = accept?.amount;
  const m = accept?.maxAmountRequired;
  if (a != null && m != null && String(a) !== String(m)) {
    throw new OfferRefusal("amount_field_conflict", "[twzrd] Base offer amount and maxAmountRequired disagree");
  }
  const amount = a ?? m;
  if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) {
    throw new OfferRefusal("amount_malformed", "[twzrd] Base offer amount is not a base-unit integer");
  }
  const asset = accept?.asset;
  if (asset != null && String(asset).toLowerCase() !== BASE_USDC) {
    throw new OfferRefusal("twzrd_non_usdc_asset", "[twzrd] Base offer names an asset other than USDC");
  }
  const priceUsdc = Number(amount) / 1_000_000;
  // 400 digits overflow Number to Infinity; the Solana hook refuses that as twzrd_invalid_price.
  if (!Number.isFinite(priceUsdc)) {
    throw new OfferRefusal("twzrd_invalid_price", "[twzrd] Base offer amount is out of range");
  }
  return { payTo, priceUsdc };
}

/**
 * The package's signing rules applied to a Base preflight card (0.11.2).
 * Before 0.11.2 this module signed on any non-block verdict.
 */
export function baseRefusal(
  verdict: BasePreflightVerdict,
  priceUsdc: number,
  options: Pick<CloudflareBaseGateOptions, "preflightMinScore" | "refuseUnevaluated"> = {},
): string | undefined {
  if (verdict.decision === "block") return "twzrd_decision_block";
  if (verdict.washFlagged === true) return "twzrd_wash_flagged";
  const cap =
    typeof verdict.recommendedCapUsdc === "number" && Number.isFinite(verdict.recommendedCapUsdc) && verdict.recommendedCapUsdc >= 0
      ? verdict.recommendedCapUsdc
      : null;
  const unevaluated = (typeof verdict.nullReason === "string" && verdict.nullReason.trim() !== "") || verdict.scoreIsNull === true;
  if (unevaluated) {
    const nr = verdict.nullReason || "score_null";
    if (isTrueFlag(options.refuseUnevaluated)) return `twzrd_unevaluated_subject_${nr}`;
    if (cap === null) return `twzrd_unevaluated_no_cap_${nr}`;
    if (priceUsdc > cap) return `twzrd_unevaluated_over_cap_${priceUsdc}_gt_${cap}`;
    return undefined;
  }
  const min = options.preflightMinScore ?? 40;
  const score = verdict.riskScore ?? 0;
  if (score < min) return `twzrd_score_${score}_below_${min}`;
  if (cap !== null && priceUsdc > cap) return `twzrd_over_recommended_cap_${priceUsdc}_gt_${cap}`;
  return undefined;
}

function normalizePreflight(value: unknown): BasePreflightVerdict {
  const response = asRecord(value);
  if (!response) throw new Error("[twzrd] Base preflight returned a non-object response");
  const card = asRecord(response.readiness_card) ?? response;
  const decision = card.decision;
  if (decision !== "allow" && decision !== "warn" && decision !== "block") {
    throw new Error("[twzrd] Base preflight returned no valid decision");
  }
  const riskScore = numberOrNull(card.risk_score) ?? numberOrNull(card.trust_score);
  const reasons = strings(card.reasons ?? card.reason_codes ?? asRecord(card.decision_envelope)?.reason_codes);
  return {
    decision,
    riskScore,
    reasons,
    nullReason: typeof card.null_reason === "string" ? card.null_reason : null,
    scoreIsNull: "score" in card && card.score === null,
    recommendedCapUsdc: numberOrNull(card.recommended_cap_usdc),
    washFlagged: typeof card.wash_flagged === "boolean" ? card.wash_flagged : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
