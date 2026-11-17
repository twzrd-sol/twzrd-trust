/**
 * Issue and verify mandates.
 *
 * `verifyMandate` never throws on a bad document: every outcome is a value
 * with a stable code, so a caller cannot mistake an exception for a pass.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type MandateKey, verifySignature } from "./keys.js";
import {
  CLOCK_SKEW_MS,
  type IssuerMode,
  type Mandate,
  type MandateBody,
  type MandateChain,
  type MandateErrorCode,
  MANDATE_SCHEMA,
  formatUtcSecond,
  mandateSigningBytes,
  parseMandate,
  parseMandateBody,
  parseUtcSecond,
} from "./schema.js";

export interface IssueMandateInput {
  issuerMode: IssuerMode;
  /** The key that signs. For `self-mandated` it is the agent's own key. */
  issuerKey: MandateKey;
  /** base58 public key of the agent runtime. Defaults to the issuer for `self-mandated`. */
  agent?: string;
  maxPerCallUsd: string;
  hourlyCeilingUsd?: string;
  dailyCeilingUsd: string;
  monthlyCeilingUsd?: string;
  allowedChains: MandateChain[];
  minTrustScore: number;
  allowedCounterparties?: string[];
  blockedCounterparties?: string[];
  allowedTools: string[];
  requireV7Receipt?: boolean;
  requireMerkleInclusion?: boolean;
  killswitchDir: string;
  task?: string;
  /** Lifetime from `now`, in milliseconds. */
  lifetimeMs: number;
  now?: number;
  mandateId?: string;
}

export function newMandateId(): string {
  return `mnd_${crypto.randomBytes(16).toString("hex")}`;
}

/** Sign a body that has already been validated. */
export function signMandateBody(body: MandateBody, issuerKey: MandateKey): Mandate {
  if (issuerKey.publicKey !== body.issuer) throw new Error("the signing key is not the mandate's issuer");
  const value = issuerKey.sign(mandateSigningBytes(body)).toString("base64");
  return { ...body, signature: { alg: "ed25519", publicKey: issuerKey.publicKey, value } };
}

/** Build, validate and sign a mandate. Throws when the input breaks a rule of the schema. */
export function issueMandate(input: IssueMandateInput): Mandate {
  const now = Math.floor((input.now ?? Date.now()) / 1000) * 1000;
  const agent = input.agent ?? (input.issuerMode === "human-operator" ? undefined : input.issuerKey.publicKey);
  if (agent === undefined) throw new Error("a human-operator mandate names the agent key it is for");
  const body: MandateBody = {
    schema: MANDATE_SCHEMA,
    mandateId: input.mandateId ?? newMandateId(),
    issuerMode: input.issuerMode,
    issuer: input.issuerKey.publicKey,
    agent,
    issuedAt: formatUtcSecond(now),
    expiresAt: formatUtcSecond(now + Math.floor(input.lifetimeMs / 1000) * 1000),
    ...(input.task !== undefined ? { task: input.task } : {}),
    limits: {
      maxPerCallUsd: input.maxPerCallUsd,
      ...(input.hourlyCeilingUsd !== undefined ? { hourlyCeilingUsd: input.hourlyCeilingUsd } : {}),
      dailyCeilingUsd: input.dailyCeilingUsd,
      ...(input.monthlyCeilingUsd !== undefined ? { monthlyCeilingUsd: input.monthlyCeilingUsd } : {}),
    },
    allowedChains: [...input.allowedChains],
    minTrustScore: input.minTrustScore,
    ...(input.allowedCounterparties?.length ? { allowedCounterparties: [...input.allowedCounterparties] } : {}),
    ...(input.blockedCounterparties?.length ? { blockedCounterparties: [...input.blockedCounterparties] } : {}),
    allowedTools: [...input.allowedTools],
    requireV7Receipt: input.requireV7Receipt === true,
    requireMerkleInclusion: input.requireMerkleInclusion === true,
    killswitchDir: input.killswitchDir,
  };
  const parsed = parseMandateBody(body);
  if (!parsed.ok) throw new Error(`cannot issue this mandate: ${parsed.detail}`);
  return signMandateBody(body, input.issuerKey);
}

export interface VerifyMandateOptions {
  /** Issuer keys this runtime accepts for mandates it did not sign itself. */
  trustedIssuers?: readonly string[];
  /** Public key of the agent key this runtime holds, if it holds one. */
  heldAgentKey?: string;
  now?: number;
}

export type VerifyMandateResult =
  | { ok: true; mandate: Mandate; expiresAtMs: number }
  | { ok: false; code: MandateErrorCode; detail: string };

/**
 * Structure, signature, issuer pin, clock: in that order, so a document that
 * is not even well formed is never described as merely expired.
 */
export function verifyMandate(input: unknown, options: VerifyMandateOptions = {}): VerifyMandateResult {
  let parsed;
  try {
    parsed = parseMandate(input);
  } catch (err) {
    return { ok: false, code: "mandate_malformed", detail: `the mandate could not be read: ${(err as Error).message}` };
  }
  if (!parsed.ok) return parsed;
  const mandate = parsed.value;

  let signed = false;
  try {
    signed = verifySignature(mandate.issuer, mandateSigningBytes(mandate), Buffer.from(mandate.signature.value, "base64"));
  } catch {
    signed = false;
  }
  if (!signed) {
    return { ok: false, code: "mandate_signature_invalid", detail: "the signature does not verify over this document" };
  }

  // A signature says which key signed, not that the key is one to obey.
  const selfSigned = mandate.issuer === mandate.agent;
  if (selfSigned) {
    if (options.heldAgentKey !== mandate.agent) {
      return {
        ok: false,
        code: "mandate_issuer_untrusted",
        detail: "this mandate is signed by its own agent key, and the runtime does not hold that key",
      };
    }
  } else if (!(options.trustedIssuers ?? []).includes(mandate.issuer)) {
    return {
      ok: false,
      code: "mandate_issuer_untrusted",
      detail: `issuer ${mandate.issuer} is not on the trusted-issuer list`,
    };
  }

  const now = options.now ?? Date.now();
  const issuedAt = parseUtcSecond(mandate.issuedAt) as number;
  const expiresAt = parseUtcSecond(mandate.expiresAt) as number;
  if (issuedAt > now + CLOCK_SKEW_MS) {
    return { ok: false, code: "mandate_not_yet_valid", detail: `issuedAt ${mandate.issuedAt} is in the future` };
  }
  if (now >= expiresAt) {
    return { ok: false, code: "mandate_expired", detail: `the mandate expired at ${mandate.expiresAt}` };
  }
  return { ok: true, mandate, expiresAtMs: expiresAt };
}

export type LoadMandateResult =
  | { ok: true; mandate: Mandate; expiresAtMs: number; filePath: string; stateDir: string }
  | { ok: false; code: MandateErrorCode; detail: string };

/** Read and verify a mandate file. The state directory is resolved against the file's own directory. */
export function loadMandateFile(filePath: string, options: VerifyMandateOptions = {}): LoadMandateResult {
  const where = path.resolve(filePath);
  let text: string;
  try {
    text = fs.readFileSync(where, "utf8");
  } catch {
    return { ok: false, code: "mandate_malformed", detail: `mandate file ${where} cannot be read` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, code: "mandate_malformed", detail: `mandate file ${where} is not JSON` };
  }
  const verified = verifyMandate(doc, options);
  if (!verified.ok) return verified;
  const stateDir = path.resolve(path.dirname(where), verified.mandate.killswitchDir);
  return { ...verified, filePath: where, stateDir };
}

/** Write a mandate file. Refuses to overwrite unless told to. */
export function writeMandateFile(filePath: string, mandate: Mandate, opts: { overwrite?: boolean } = {}): string {
  const where = path.resolve(filePath);
  fs.mkdirSync(path.dirname(where), { recursive: true });
  fs.writeFileSync(where, `${JSON.stringify(mandate, null, 2)}\n`, { flag: opts.overwrite ? "w" : "wx", mode: 0o644 });
  return where;
}
