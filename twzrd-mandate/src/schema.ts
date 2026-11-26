/**
 * `twzrd.mandate.v1`: the document, its structural rules, and the signed
 * bytes. SPEC.md is the normative description.
 *
 * `parseMandate` checks structure only. `verifyMandate` (verify.ts) adds the
 * signature, the issuer pin and the clock.
 */
import { canonicalJson } from "twzrd-x402-gate";
import { decodePublicKey } from "./keys.js";

export const MANDATE_SCHEMA = "twzrd.mandate.v1";
export const MANDATE_SIGNING_DOMAIN = "TWZRD:MANDATE_V1\n";
export const ISSUER_MODES = ["human-operator", "self-mandated", "ephemeral-session"] as const;
export type IssuerMode = (typeof ISSUER_MODES)[number];
export const MANDATE_CHAINS = ["solana", "base"] as const;
export type MandateChain = (typeof MANDATE_CHAINS)[number];

/** Longest lifetime of a standing mandate, and of an ephemeral session. */
export const MAX_LIFETIME_MS = 366 * 24 * 60 * 60 * 1000;
export const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** How far in the future `issuedAt` may be before the mandate is refused. */
export const CLOCK_SKEW_MS = 300 * 1000;

export interface MandateLimits {
  maxPerCallUsd: string;
  hourlyCeilingUsd?: string;
  dailyCeilingUsd: string;
  monthlyCeilingUsd?: string;
}

export interface MandateSignature {
  alg: "ed25519";
  publicKey: string;
  value: string;
}

/** The signed part of a mandate. */
export interface MandateBody {
  schema: typeof MANDATE_SCHEMA;
  mandateId: string;
  issuerMode: IssuerMode;
  issuer: string;
  agent: string;
  issuedAt: string;
  expiresAt: string;
  task?: string;
  limits: MandateLimits;
  allowedChains: MandateChain[];
  minTrustScore: number;
  /**
   * The trust screen (layer 5 preflight). `"on"` is the default and the only
   * behavior older mandates know. `"off"` skips the preflight by explicit
   * operator choice and records a `trust_screen_off` control line per
   * payment; it is fail-open and must never be the default.
   */
  trustScreen?: "on" | "off";
  allowedCounterparties?: string[];
  blockedCounterparties?: string[];
  allowedTools: string[];
  requireV7Receipt: boolean;
  requireMerkleInclusion: boolean;
  killswitchDir: string;
}

export interface Mandate extends MandateBody {
  signature: MandateSignature;
}

export type MandateErrorCode =
  | "mandate_malformed"
  | "mandate_unsigned"
  | "mandate_signature_invalid"
  | "mandate_issuer_untrusted"
  | "mandate_not_yet_valid"
  | "mandate_expired";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: MandateErrorCode; detail: string };

const BODY_KEYS = new Set([
  "schema",
  "mandateId",
  "issuerMode",
  "issuer",
  "agent",
  "issuedAt",
  "expiresAt",
  "task",
  "limits",
  "allowedChains",
  "minTrustScore",
  "trustScreen",
  "allowedCounterparties",
  "blockedCounterparties",
  "allowedTools",
  "requireV7Receipt",
  "requireMerkleInclusion",
  "killswitchDir",
]);
const LIMIT_KEYS = new Set(["maxPerCallUsd", "hourlyCeilingUsd", "dailyCeilingUsd", "monthlyCeilingUsd"]);
const SIGNATURE_KEYS = new Set(["alg", "publicKey", "value"]);

const USD_RE = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/;
const UTC_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/;
const ID_RE = /^mnd_[0-9a-f]{32}$/;
const TOOL_RE = /^[\x21-\x7e]{1,200}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

/** A USD decimal string as micro-dollars; null when it is not in the accepted form. */
export function usdToMicro(value: unknown): bigint | null {
  if (typeof value !== "string" || !USD_RE.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole as string) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

/** Micro-dollars as a decimal string with no trailing zeros ("0.01", "5", "0"). */
export function microToUsd(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Parse a whole-second UTC timestamp; null unless it is a real instant written canonically. */
export function parseUtcSecond(value: unknown): number | null {
  if (typeof value !== "string" || !UTC_RE.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // Date.parse accepts "2026-02-31": only a value that prints back identically is real.
  if (formatUtcSecond(ms) !== value) return null;
  return ms;
}

export function formatUtcSecond(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function bad(detail: string): { ok: false; code: MandateErrorCode; detail: string } {
  return { ok: false, code: "mandate_malformed", detail };
}

function isRecipient(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return EVM_RE.test(value) || decodePublicKey(value) !== null;
}

function stringList(
  value: unknown,
  name: string,
  each: (item: unknown) => boolean,
  opts: { min: number; max: number },
): string | null {
  if (!Array.isArray(value)) return `${name} must be an array`;
  if (value.length < opts.min) return `${name} must not be empty`;
  if (value.length > opts.max) return `${name} has more than ${opts.max} entries`;
  const seen = new Set<string>();
  for (const item of value) {
    if (!each(item)) return `${name} holds an entry that is not valid`;
    const key = String(item);
    if (seen.has(key)) return `${name} repeats an entry`;
    seen.add(key);
  }
  return null;
}

/** Structural validation of the signed part. Unknown members are refused. */
export function parseMandateBody(input: unknown): ParseResult<MandateBody> {
  if (!isPlainObject(input)) return bad("a mandate is a JSON object");
  for (const key of Object.keys(input)) {
    if (!BODY_KEYS.has(key)) return bad(`unknown member "${key}"`);
  }
  if (input.schema !== MANDATE_SCHEMA) return bad(`schema must be "${MANDATE_SCHEMA}"`);
  if (typeof input.mandateId !== "string" || !ID_RE.test(input.mandateId)) {
    return bad("mandateId must be mnd_ followed by 32 lowercase hex characters");
  }
  if (typeof input.issuerMode !== "string" || !(ISSUER_MODES as readonly string[]).includes(input.issuerMode)) {
    return bad(`issuerMode must be one of ${ISSUER_MODES.join(", ")}`);
  }
  const issuerMode = input.issuerMode as IssuerMode;
  if (decodePublicKey(input.issuer) === null) return bad("issuer must be a base58 Ed25519 public key");
  if (decodePublicKey(input.agent) === null) return bad("agent must be a base58 Ed25519 public key");
  const issuer = input.issuer as string;
  const agent = input.agent as string;
  if (issuerMode === "human-operator" && issuer === agent) {
    return bad("a human-operator mandate is signed by a key other than the agent's");
  }
  if (issuerMode === "self-mandated" && issuer !== agent) {
    return bad("a self-mandated mandate is signed by the agent's own key");
  }

  const issuedAt = parseUtcSecond(input.issuedAt);
  const expiresAt = parseUtcSecond(input.expiresAt);
  if (issuedAt === null) return bad("issuedAt must be YYYY-MM-DDTHH:MM:SSZ");
  if (expiresAt === null) return bad("expiresAt must be YYYY-MM-DDTHH:MM:SSZ");
  if (expiresAt <= issuedAt) return bad("expiresAt must be after issuedAt");
  const lifetime = expiresAt - issuedAt;
  if (issuerMode === "ephemeral-session") {
    if (lifetime > MAX_SESSION_LIFETIME_MS) return bad("an ephemeral-session mandate lasts at most 24 hours");
    if (typeof input.task !== "string" || input.task.length < 1 || input.task.length > 200) {
      return bad("an ephemeral-session mandate names its task (1 to 200 characters)");
    }
  } else {
    if (lifetime > MAX_LIFETIME_MS) return bad("a mandate lasts at most 366 days");
    if (Object.prototype.hasOwnProperty.call(input, "task")) return bad("task is only for ephemeral-session mandates");
  }

  if (!isPlainObject(input.limits)) return bad("limits must be an object");
  for (const key of Object.keys(input.limits)) {
    if (!LIMIT_KEYS.has(key)) return bad(`unknown member "limits.${key}"`);
  }
  const perCall = usdToMicro(input.limits.maxPerCallUsd);
  const daily = usdToMicro(input.limits.dailyCeilingUsd);
  if (perCall === null) return bad("limits.maxPerCallUsd must be a decimal string with at most 6 places");
  if (daily === null) return bad("limits.dailyCeilingUsd must be a decimal string with at most 6 places");
  let hourly: bigint | null = null;
  let monthly: bigint | null = null;
  if (Object.prototype.hasOwnProperty.call(input.limits, "hourlyCeilingUsd")) {
    hourly = usdToMicro(input.limits.hourlyCeilingUsd);
    if (hourly === null) return bad("limits.hourlyCeilingUsd must be a decimal string with at most 6 places");
  }
  if (Object.prototype.hasOwnProperty.call(input.limits, "monthlyCeilingUsd")) {
    monthly = usdToMicro(input.limits.monthlyCeilingUsd);
    if (monthly === null) return bad("limits.monthlyCeilingUsd must be a decimal string with at most 6 places");
  }
  if (perCall <= 0n) return bad("limits.maxPerCallUsd must be greater than zero");
  if (perCall > (hourly ?? daily)) return bad("limits.maxPerCallUsd must not exceed the hourly ceiling");
  if (hourly !== null && hourly > daily) return bad("limits.hourlyCeilingUsd must not exceed the daily ceiling");
  if (monthly !== null && daily > monthly) return bad("limits.dailyCeilingUsd must not exceed the monthly ceiling");

  const chainsError = stringList(
    input.allowedChains,
    "allowedChains",
    (c) => typeof c === "string" && (MANDATE_CHAINS as readonly string[]).includes(c),
    { min: 1, max: MANDATE_CHAINS.length },
  );
  if (chainsError) return bad(chainsError);

  if (typeof input.minTrustScore !== "number" || !Number.isInteger(input.minTrustScore) || input.minTrustScore < 0 || input.minTrustScore > 100) {
    return bad("minTrustScore must be an integer from 0 to 100");
  }
  if (Object.prototype.hasOwnProperty.call(input, "trustScreen")) {
    if (input.trustScreen !== "on" && input.trustScreen !== "off") {
      return bad('trustScreen must be "on" or "off"');
    }
  }

  for (const name of ["allowedCounterparties", "blockedCounterparties"] as const) {
    if (!Object.prototype.hasOwnProperty.call(input, name)) continue;
    const error = stringList(input[name], name, isRecipient, { min: 0, max: 256 });
    if (error) return bad(error);
  }
  const allowed = (input.allowedCounterparties as string[] | undefined) ?? [];
  const blocked = new Set((input.blockedCounterparties as string[] | undefined) ?? []);
  if (allowed.some((a) => blocked.has(a))) return bad("a counterparty is both allowed and blocked");

  const toolsError = stringList(
    input.allowedTools,
    "allowedTools",
    (t) => typeof t === "string" && TOOL_RE.test(t) && t !== "*",
    { min: 1, max: 256 },
  );
  if (toolsError) return bad(toolsError);

  if (typeof input.requireV7Receipt !== "boolean") return bad("requireV7Receipt must be true or false");
  if (typeof input.requireMerkleInclusion !== "boolean") return bad("requireMerkleInclusion must be true or false");
  if (input.requireMerkleInclusion && !input.requireV7Receipt) {
    return bad("requireMerkleInclusion needs requireV7Receipt");
  }
  if (typeof input.killswitchDir !== "string" || input.killswitchDir.length < 1 || input.killswitchDir.length > 1024 || input.killswitchDir.includes("\0")) {
    return bad("killswitchDir must be a path");
  }
  return { ok: true, value: input as unknown as MandateBody };
}

/**
 * Structural validation of a whole document. A missing `signature` is its own
 * code so a caller can tell "never signed" from "damaged".
 */
export function parseMandate(input: unknown): ParseResult<Mandate> {
  if (!isPlainObject(input)) return bad("a mandate is a JSON object");
  if (!Object.prototype.hasOwnProperty.call(input, "signature")) {
    return { ok: false, code: "mandate_unsigned", detail: "the mandate has no signature" };
  }
  const { signature, ...rest } = input;
  if (!isPlainObject(signature)) return bad("signature must be an object");
  for (const key of Object.keys(signature)) {
    if (!SIGNATURE_KEYS.has(key)) return bad(`unknown member "signature.${key}"`);
  }
  if (signature.alg !== "ed25519") return bad('signature.alg must be "ed25519"');
  if (decodePublicKey(signature.publicKey) === null) return bad("signature.publicKey must be a base58 Ed25519 public key");
  if (typeof signature.value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature.value)) {
    return bad("signature.value must be 64 bytes in padded base64");
  }
  const bytes = Buffer.from(signature.value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== signature.value) {
    return bad("signature.value is not canonical base64");
  }
  const body = parseMandateBody(rest);
  if (!body.ok) return body;
  if (signature.publicKey !== body.value.issuer) return bad("signature.publicKey must equal issuer");
  return { ok: true, value: input as unknown as Mandate };
}

/** The bytes an issuer signs: the domain line, then the canonical JSON of the body. */
export function mandateSigningBytes(body: MandateBody): Buffer {
  const { signature: _ignored, ...unsigned } = body as MandateBody & { signature?: unknown };
  return Buffer.from(MANDATE_SIGNING_DOMAIN + canonicalJson(unsigned), "utf8");
}

/** The limits in micro-dollars, with the hourly ceiling defaulted to the daily one. */
export function mandateLimitsMicro(mandate: MandateBody): {
  perCall: bigint;
  hourly: bigint;
  daily: bigint;
  monthly: bigint | null;
} {
  const perCall = usdToMicro(mandate.limits.maxPerCallUsd);
  const daily = usdToMicro(mandate.limits.dailyCeilingUsd);
  if (perCall === null || daily === null) throw new Error("mandate limits were not validated");
  const hourly = mandate.limits.hourlyCeilingUsd === undefined ? daily : usdToMicro(mandate.limits.hourlyCeilingUsd);
  const monthly = mandate.limits.monthlyCeilingUsd === undefined ? null : usdToMicro(mandate.limits.monthlyCeilingUsd);
  if (hourly === null) throw new Error("mandate limits were not validated");
  return { perCall, hourly, daily, monthly };
}
