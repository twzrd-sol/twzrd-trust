/**
 * Evidence bundle verification — machine checks, not author claims.
 *
 * `exportEvidenceBundle()` produces a document. This module decides whether
 * that document is worth anything. Everything here is offline, deterministic,
 * and dependency-free (node:crypto only), so a FOREIGN OPERATOR can re-run it
 * against a published bundle and reach the same verdict TWZRD would.
 *
 * Design rule: a claim is either MACHINE-VERIFIED here or it is labelled
 * ASSERTED in the report. There is no third category.
 *
 * Part 1 (this section): scrub-clean is a PROOF, not a promise. The old
 * redactor dropped keys matching a name regex and then asserted a hardcoded
 * `redactions` list regardless of what happened. A wallet nested under an
 * innocuous key name survived that and the bundle still claimed it was clean.
 * `scanForSecretValues` looks at VALUES.
 */

import { createHash } from "node:crypto";

import {
  computeDecisionOutcomeLeafV1,
  verifyOutcomeAttestationSignature,
  type DecisionOutcomeFields,
} from "./outcome-attestation.js";
import { resourceBindLeafHash, type ResourceBindReq } from "./resource-bind.js";

export const EVIDENCE_VERIFICATION_SCHEMA = "twzrd.evidence_verification.v1" as const;

/** Base58 alphabet (Bitcoin/Solana): no 0, O, I, l. */
const B58 = "[1-9A-HJ-NP-Za-km-z]";

export type SecretKind =
  | "pem_block"
  | "jwt"
  | "bearer_token"
  | "env_assignment"
  | "home_path"
  | "base58_secret_key"
  | "long_hex"
  | "evm_address"
  | "base58_pubkey";

export type SecretFinding = {
  /** Dotted path into the bundle. `…#key` means the KEY text, not the value. */
  path: string;
  kind: SecretKind;
  severity: "violation" | "waived";
  /** Never the raw hit: kind + length + sha256 prefix, so it stays scrub-clean. */
  preview: string;
  waivedBy?: string;
  waiverReason?: string;
};

type Rule = { kind: SecretKind; re: RegExp; waivable: boolean };

/**
 * Ordered most-specific-first. `waivable: false` kinds can NEVER be allowlisted
 * at any path — a PEM block or a JWT in an evidence bundle is always a leak.
 */
const RULES: readonly Rule[] = [
  {
    kind: "pem_block",
    re: /-----BEGIN[ A-Z]*(?:PRIVATE KEY|CERTIFICATE|PARAMETERS)[ A-Z]*-----/,
    waivable: false,
  },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, waivable: false },
  { kind: "bearer_token", re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i, waivable: false },
  {
    kind: "env_assignment",
    re: /\b[A-Z][A-Z0-9_]{2,}(?:KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|SEED|MNEMONIC|CREDENTIALS?)\s*=\s*\S/,
    waivable: false,
  },
  {
    kind: "home_path",
    re: /(?:\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|\/root|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)[/\\]/,
    waivable: false,
  },
  // 64-byte ed25519 material in base58 is 86-90 chars. A SIGNATURE is the same
  // length class as a SECRET KEY — they cannot be told apart by shape, which is
  // why the only waiver for this kind is one exact path (see WAIVERS).
  {
    kind: "base58_secret_key",
    re: new RegExp(`(?<!${B58})(${B58}{86,90})(?!${B58})`),
    waivable: true,
  },
  // KNOWN COVERAGE GAP (measured, not theoretical): base58 runs of 45-85 chars
  // match NEITHER rule — base58_pubkey caps at 44, base58_secret_key starts at
  // 86. No ed25519/Solana artifact lands in that band, which is why it is
  // unclaimed, but base58check formats do (a Bitcoin WIF key is 51-52). A
  // string in that band therefore passes verifyScrubClean(). Reproduce: put a
  // 66-char base58 run in decision.reason -> clean=true, 0 violations.
  // Do not read "scrub_clean" as covering that band.
  { kind: "long_hex", re: /(?<![0-9a-fA-Fx])(?:0x)?([0-9a-fA-F]{64,})(?![0-9a-fA-F])/, waivable: true },
  { kind: "evm_address", re: /(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/, waivable: true },
  // 32-byte base58 (Solana pubkey / keypair address). The three lookaheads
  // demand mixed case + a digit so ordinary slugs ("gate-adoption-proof" has
  // hyphens; "blockednever" is single-case) do not trip it.
  {
    kind: "base58_pubkey",
    re: new RegExp(
      `(?<!${B58})(?=${B58}{32,44}(?!${B58}))(?=[^]*[A-HJ-NP-Z])(?=[^]*[a-km-z])(?=[^]*[1-9])(${B58}{32,44})(?!${B58})`,
    ),
    waivable: true,
  },
] as const;

/**
 * Path-scoped waivers. Each one is a deliberate, reviewable statement that a
 * secret-SHAPED value at exactly this path is a public artifact. Anything not
 * listed here is a violation — the allowlist is closed, not open.
 */
const WAIVERS: ReadonlyArray<{
  id: string;
  path: RegExp;
  kinds: readonly SecretKind[];
  why: string;
}> = [
  {
    id: "bind_leaf_hash",
    path: /^bind\.leaf_hash$/,
    kinds: ["long_hex"],
    why: "resource-bind v1 leaf is a public sha256 digest of the 402 offer",
  },
  {
    id: "receipt_leaf",
    path: /^receipt\.(leaf|leaf_hash)$/,
    kinds: ["long_hex"],
    why: "receipt leaf mirrors the public bind leaf (spend-control.ts:180)",
  },
  {
    id: "outcome_leaf",
    path: /^outcomeAttestation\.leaf$/,
    kinds: ["long_hex"],
    why: "keccak256 outcome leaf is published for relying parties to verify",
  },
  {
    id: "ledger_last_hash",
    path: /^ledger\.lastHash$/,
    kinds: ["long_hex"],
    why: "hash-chain head of the local decision ledger; not a credential",
  },
  {
    id: "outcome_signing_pubkey",
    path: /^outcomeAttestation\.signing_pubkey$/,
    kinds: ["base58_pubkey"],
    why: "operator's PUBLIC Ed25519 decision key — the trust anchor, published on purpose",
  },
  {
    id: "outcome_signature",
    path: /^outcomeAttestation\.signature$/,
    kinds: ["base58_secret_key"],
    why: "64-byte Ed25519 signature; length-identical to a secret key, so waived by exact path ONLY",
  },
  // The offer projection. These are DELIBERATELY published: without them
  // bind.leaf_hash cannot be recomputed and the bind is an unverifiable blob.
  // They are the merchant side of a refused payment — never the buyer's.
  {
    id: "offer_counterparty",
    path: /^requirements\.(payTo|asset)$/,
    kinds: ["base58_pubkey"],
    why: "merchant payTo and asset mint are the SUBJECT of the evidence and inputs to resourceBindLeafHash()",
  },
  {
    id: "offer_network",
    path: /^requirements\.network$/,
    kinds: ["base58_pubkey"],
    why: "CAIP-2 chain id (public genesis hash), not an account",
  },
  {
    id: "outcome_preimage",
    path: /^outcomeAttestation\.preimage\.(intent_hash|payer|settlement_anchor|settlement_tx|counterparty)$/,
    kinds: ["long_hex", "base58_pubkey", "base58_secret_key"],
    why: "attestation preimage is published so relying parties can recompute the leaf",
  },
];

function mask(hit: string, kind: SecretKind): string {
  const digest = createHash("sha256").update(hit).digest("hex").slice(0, 12);
  return `<${kind} len=${hit.length} sha256=${digest}>`;
}

function walk(node: unknown, path: string, emit: (path: string, text: string) => void): void {
  if (typeof node === "string") return emit(path || "(root)", node);
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${path}[${i}]`, emit));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    emit(`${next}#key`, key);
    walk(child, next, emit);
  }
}

/**
 * Scan every string VALUE (and key name) in a parsed bundle for secret-shaped
 * content. Path-based, so the finding tells a reviewer exactly where to look.
 */
export function scanForSecretValues(value: unknown): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  walk(value, "", (path, text) => {
    for (const rule of RULES) {
      const m = rule.re.exec(text);
      if (!m) continue;
      const dedupe = `${path}|${rule.kind}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const waiver = rule.waivable
        ? WAIVERS.find((w) => w.kinds.includes(rule.kind) && w.path.test(path))
        : undefined;
      findings.push({
        path,
        kind: rule.kind,
        severity: waiver ? "waived" : "violation",
        preview: mask(m[1] ?? m[0], rule.kind),
        ...(waiver ? { waivedBy: waiver.id, waiverReason: waiver.why } : {}),
      });
    }
  });
  return findings;
}

export type ScrubReport = {
  clean: boolean;
  violations: SecretFinding[];
  waived: SecretFinding[];
  scannedBytes: number;
};

/** Scrub-clean as a decision a reviewer can re-derive, not a sentence in a list. */
export function verifyScrubClean(bundle: unknown): ScrubReport {
  const findings = scanForSecretValues(bundle);
  const serialized = JSON.stringify(bundle) ?? "";
  return {
    clean: findings.every((f) => f.severity !== "violation"),
    violations: findings.filter((f) => f.severity === "violation"),
    waived: findings.filter((f) => f.severity === "waived"),
    scannedBytes: Buffer.byteLength(serialized, "utf8"),
  };
}

/* ------------------------------------------------------------------ */
/* Part 2: schema + invariant validation                              */
/*                                                                     */
/* A foreign operator publishing a bundle, and anyone reading it, need */
/* one answer: is this well-formed, and does it contradict itself?     */
/* Everything below is a check whose failure means the DOCUMENT is     */
/* wrong — not that the gate misbehaved.                              */
/* ------------------------------------------------------------------ */

export type ValidationError = {
  code: string;
  path: string;
  message: string;
  severity: "error" | "warning";
};

export type ValidationReport = { ok: boolean; errors: ValidationError[] };

const LINEAGE_VALUES = ["dogfood", "external_candidate"] as const;
const EXTERNAL_RUN_RE = /\bexternal[_\s-]?run\b/i;
/** Paths where the STRING "EXTERNAL_RUN" is a disclaimer, not a claim. */
const EXTERNAL_RUN_DISCLAIMER = /^(?:notExternalRunProof|transcript\.notExternalRunProof|acceptanceDoc)/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isInt0 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;
const isHex64 = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);

/**
 * Mirrors adoption-proof.ts `isInternalIntegration` WITHOUT importing it, so
 * this verifier stays standalone for a foreign operator who vendors one file.
 * Kept deliberately at least as broad as the original: over-classifying a run
 * as internal only ever costs a claim, it never grants one.
 */
export function looksSelfAuthored(integration: string): boolean {
  const i = integration.toLowerCase();
  return (
    i.startsWith("twzrd-") || i.startsWith("twzrd/") || i.startsWith("ops-") ||
    i.startsWith("test-") || i.startsWith("demo-") || i === "dogfood" ||
    i.includes("dogfood") || i.includes("internal") || i.includes("ci-") ||
    i === "gate-adoption-proof"
  );
}

function requireField(
  out: ValidationError[], obj: Record<string, unknown>, path: string,
  ok: (v: unknown) => boolean, message: string, code = "invalid_field",
): boolean {
  const key = path.split(".").pop()!;
  if (ok(obj[key])) return true;
  out.push({ code, path, message, severity: "error" });
  return false;
}

function validateShape(b: Record<string, unknown>, e: ValidationError[]): void {
  requireField(e, b, "schema", (v) => v === "twzrd.evidence_bundle.v1",
    'schema must be exactly "twzrd.evidence_bundle.v1"', "schema_mismatch");
  requireField(e, b, "package", (v) => v === "twzrd-x402-gate",
    'package must be "twzrd-x402-gate"', "package_mismatch");
  requireField(e, b, "packageVersion", isStr, "packageVersion must be a non-empty string");
  requireField(e, b, "exportedAt",
    (v) => isStr(v) && !Number.isNaN(Date.parse(v)),
    "exportedAt must be an ISO-8601 timestamp");
  requireField(e, b, "notExternalRunProof",
    (v) => Array.isArray(v) && v.length > 0 && v.every((x) => isStr(x)),
    "notExternalRunProof must be a non-empty list of strings");

  if (requireField(e, b, "attribution", isObj, "attribution must be an object")) {
    const a = b.attribution as Record<string, unknown>;
    requireField(e, a, "attribution.integration", isStr, "attribution.integration is required");
    requireField(e, a, "attribution.runId", isStr, "attribution.runId is required");
  }
  if (requireField(e, b, "decision", isObj, "decision must be an object")) {
    const d = b.decision as Record<string, unknown>;
    requireField(e, d, "decision.verdict", isStr, "decision.verdict must be a non-empty string");
    requireField(e, d, "decision.approved", (v) => typeof v === "boolean",
      "decision.approved must be a boolean");
    requireField(e, d, "decision.signerInvocations", isInt0,
      "decision.signerInvocations must be an integer >= 0");
  }
  if (requireField(e, b, "ledger", isObj, "ledger must be an object")) {
    const l = b.ledger as Record<string, unknown>;
    requireField(e, l, "ledger.spendRows", isInt0, "ledger.spendRows must be an integer >= 0");
    requireField(e, l, "ledger.verdicts", (v) => Array.isArray(v),
      "ledger.verdicts must be an array");
  }
}

/* ------------------------------------------------------------------ */
/* Part 3: self-contradiction + lineage honesty                        */
/*                                                                     */
/* A bundle can be perfectly well-typed and still be a lie. These are  */
/* the checks that catch a document disagreeing with ITSELF, and the   */
/* one check that stops a self-authored run from dressing up as        */
/* external adoption.                                                  */
/* ------------------------------------------------------------------ */

const OUTCOME_KINDS = ["settled", "blocked_never_signed", "expired_unused"] as const;
const SIGNER_SOURCES = ["transcript_step", "explicit_caller", "unknown"] as const;

const err = (
  e: ValidationError[], code: string, path: string, message: string,
  severity: ValidationError["severity"] = "error",
): void => { e.push({ code, path, message, severity }); };

/** Optional sections: absent is fine, present-and-malformed is not. */
function validateSections(b: Record<string, unknown>, e: ValidationError[]): void {
  requireField(e, b, "lineage", (v) => LINEAGE_VALUES.includes(v as never),
    `lineage must be one of ${LINEAGE_VALUES.join(" | ")}`, "lineage_invalid");
  requireField(e, b, "redactions",
    (v) => Array.isArray(v) && v.every((x) => isStr(x)),
    "redactions must be an array of strings");

  if (b.bind !== undefined) {
    if (!isObj(b.bind)) return err(e, "invalid_field", "bind", "bind must be an object");
    const leaf = (b.bind as Record<string, unknown>).leaf_hash;
    if (leaf !== undefined && leaf !== null && !isHex64(leaf)) {
      err(e, "bind_leaf_malformed", "bind.leaf_hash",
        "bind.leaf_hash must be 64 hex chars or null (resource-bind v1 is sha256)");
    }
  }
  if (b.receipt !== undefined && !isObj(b.receipt)) {
    err(e, "invalid_field", "receipt", "receipt must be an object");
  }
  if (b.outcomeAttestation !== undefined) {
    if (!isObj(b.outcomeAttestation)) {
      return err(e, "invalid_field", "outcomeAttestation", "outcomeAttestation must be an object");
    }
    const o = b.outcomeAttestation as Record<string, unknown>;
    if (!OUTCOME_KINDS.includes(o.outcome as never)) {
      err(e, "outcome_invalid", "outcomeAttestation.outcome",
        `outcome must be one of ${OUTCOME_KINDS.join(" | ")}`);
    }
  }
}

/**
 * Self-contradiction. Every rule here is a statement the bundle makes about
 * itself that cannot be true at the same time as another.
 *
 * The headline one: `approved:false` with `signerInvocations > 0` means the
 * gate refused AND the signer ran. That is the exact failure the whole
 * "agents do not sign blind" claim exists to rule out, so a bundle asserting
 * it is not evidence of safety — it is evidence of a breach or of a forged
 * document. Either way it must never validate.
 */
function validateCoherence(b: Record<string, unknown>, e: ValidationError[]): void {
  const d = isObj(b.decision) ? b.decision : null;
  if (!d) return;
  const approved = d.approved;
  const signer = d.signerInvocations;

  if (approved === false && isInt0(signer) && signer > 0) {
    err(e, "refused_but_signed", "decision.signerInvocations",
      `bundle claims approved:false but records ${signer} signer invocation(s) — ` +
      "a refused payment cannot have reached a signer");
  }
  if (approved === true && isInt0(signer) && signer === 0 && isStr(d.verdict) && d.verdict === "block") {
    err(e, "approved_block_verdict", "decision.verdict",
      'decision.approved:true contradicts verdict "block"');
  }

  // Where did the signer count come from? Without this a reviewer cannot tell
  // whether 0 covers the whole run or one cherry-picked step.
  const prov = d.signerProvenance;
  if (prov === undefined) {
    err(e, "signer_provenance_missing", "decision.signerProvenance",
      "signer count is untraceable: no signerProvenance recording which step of " +
      "which transcript it was read from", "warning");
  } else if (!isObj(prov)) {
    err(e, "invalid_field", "decision.signerProvenance", "signerProvenance must be an object");
  } else {
    if (!SIGNER_SOURCES.includes(prov.source as never)) {
      err(e, "signer_provenance_invalid", "decision.signerProvenance.source",
        `source must be one of ${SIGNER_SOURCES.join(" | ")}`);
    }
    if (prov.source === "transcript_step" && !isStr(prov.step)) {
      err(e, "signer_provenance_invalid", "decision.signerProvenance.step",
        'source "transcript_step" requires the step name it was read from');
    }
    // A count read from ONE step while the transcript has more is a partial
    // reading. Say so — silence here is how allow_path went unreported.
    if (isInt0(prov.stepsTotal) && isInt0(prov.stepsCounted) && prov.stepsCounted < prov.stepsTotal) {
      const all = prov.allStepsSignerInvocations;
      const elsewhere = isInt0(all) && isInt0(signer) && all > signer
        ? `; the uncounted step(s) recorded ${all - signer} signer invocation(s)`
        : "";
      err(e, "signer_count_partial", "decision.signerProvenance",
        `signer count covers ${prov.stepsCounted} of ${prov.stepsTotal} transcript steps${elsewhere}`,
        "warning");
    }
  }

  // Mirrors outcome-attestation.ts checkContract() at the BUNDLE layer.
  const o = isObj(b.outcomeAttestation) ? b.outcomeAttestation : null;
  if (o) {
    if (o.outcome === "blocked_never_signed" && approved === true) {
      err(e, "outcome_contradicts_decision", "outcomeAttestation.outcome",
        "outcome blocked_never_signed contradicts decision.approved:true");
    }
    if (o.outcome === "settled" && approved === false) {
      err(e, "outcome_contradicts_decision", "outcomeAttestation.outcome",
        "outcome settled contradicts decision.approved:false (gate breach shape)");
    }
    if (o.outcome === "blocked_never_signed" && isInt0(signer) && signer > 0) {
      err(e, "outcome_contradicts_signer", "outcomeAttestation.outcome",
        `outcome blocked_never_signed contradicts ${signer} signer invocation(s)`);
    }
  }
}

/**
 * Lineage honesty.
 *
 * KNOWN DEFECT THIS EXISTS TO CONTAIN: in adoption-proof.ts the lineage is
 * `opts.lineage ?? (isInternalIntegration(integration) ? ... )`. The explicit
 * option wins unconditionally, so isInternalIntegration() is a DEFAULT, never
 * a GUARD — an integration id that trips five internal predicates still emits
 * lineage:"external_candidate" when the caller passes the flag. The transcript
 * layer cannot refuse it. The BUNDLE layer can, and does, here.
 *
 * Second rule, stronger: nothing in this package can produce EXTERNAL_RUN.
 * That status needs a server-side join the acceptance doc specifies and a
 * locally-run harness structurally cannot supply. A self-authored run is
 * NEVER EXTERNAL_RUN, so a bundle asserting it is rejected outright.
 */
function validateLineage(b: Record<string, unknown>, e: ValidationError[]): void {
  const a = isObj(b.attribution) ? b.attribution : null;
  const integration = a && isStr(a.integration) ? a.integration : "";

  if (b.lineage === "external_candidate" && integration && looksSelfAuthored(integration)) {
    err(e, "lineage_forged", "lineage",
      `lineage "external_candidate" contradicts a self-authored integration id ` +
      `(${JSON.stringify(integration)} matches the internal-integration predicate). ` +
      "An explicit lineage flag is not evidence of an external operator.");
  }

  if (b.externalRunEligible === true) {
    err(e, "external_run_asserted", "externalRunEligible",
      "no locally produced bundle is EXTERNAL_RUN eligible: that status requires " +
      "the server-side join described in the acceptance doc");
  }

  // Any EXTERNAL_RUN claim anywhere in the document, outside the fields whose
  // whole job is to disclaim it.
  walk(b, "", (path, text) => {
    if (!EXTERNAL_RUN_RE.test(text)) return;
    if (EXTERNAL_RUN_DISCLAIMER.test(path)) return;
    err(e, "external_run_asserted", path,
      `"EXTERNAL_RUN" asserted at ${path}; this bundle is correlation evidence only`);
  });

  // The transcript disclaims the server-side join by name. A bundle that
  // drops that line is a WEAKER disclaimer than the artifact it summarizes.
  const proof = Array.isArray(b.notExternalRunProof) ? b.notExternalRunProof : [];
  if (proof.length > 0 && !proof.some((p) => typeof p === "string" && /server[_\s-]?side[_\s-]?join|harness_alone/i.test(p))) {
    err(e, "disclaimer_weakened", "notExternalRunProof",
      "notExternalRunProof omits the server-side-join disclaimer that the " +
      "adoption transcript carries; the bundle disclaims less than its source",
      "warning");
  }
}

/**
 * Validate a parsed evidence bundle. Structure, enums, and self-consistency —
 * no cryptography, no I/O. `ok` is false iff at least one error-severity
 * problem was found; warnings never flip it but are always reported.
 */
export function validateEvidenceBundle(value: unknown): ValidationReport {
  const errors: ValidationError[] = [];
  if (!isObj(value)) {
    return {
      ok: false,
      errors: [{
        code: "not_an_object", path: "(root)",
        message: "evidence bundle must be a JSON object", severity: "error",
      }],
    };
  }
  validateShape(value, errors);
  validateSections(value, errors);
  validateCoherence(value, errors);
  validateLineage(value, errors);
  return { ok: !errors.some((x) => x.severity === "error"), errors };
}

/* ------------------------------------------------------------------ */
/* Part 4: linkage — does the evidence bind to the decision it claims? */
/*                                                                     */
/* bind and receipt are pass-through blobs today: the bundle repeats    */
/* whatever it was handed. Each check below RECOMPUTES a value from     */
/* another part of the same document using the package's own producer   */
/* function, so a mismatch is arithmetic, not opinion.                  */
/*                                                                     */
/* Only linkages the codebase can actually produce are checked here.    */
/* Where a check cannot run (input absent, optional peer dep missing)   */
/* it reports "unchecked" and NEVER "verified" — a skipped check that   */
/* reads as a pass is how a bundle gets trusted for the wrong reason.   */
/* ------------------------------------------------------------------ */

export type LinkStatus = "verified" | "failed" | "unchecked";

export type LinkCheck = {
  id: string;
  status: LinkStatus;
  /** Why an unchecked check could not run. */
  reason?: "absent" | "malformed" | "dependency_missing";
  /**
   * Set when the check verified only INTERNAL consistency: the document
   * agreeing with itself, with no independently anchored input. A forger who
   * rewrites both sides passes it, so it must never be promoted to
   * MACHINE_VERIFIED.
   */
  selfAnchored?: true;
  detail: string;
};

export type LinkageReport = { ok: boolean; checks: LinkCheck[] };

/** strength -> evidence_level is a bijection across all three constructors
 *  in resource-bind.ts (refuse/stamp/evaluate). A pair outside it is forged. */
const BIND_LEVELS: Record<string, string> = {
  refuse: "unbound",
  soft: "client_stamped",
  hard: "tx_included",
};

const ck = (id: string, status: LinkStatus, detail: string, reason?: LinkCheck["reason"]): LinkCheck =>
  reason ? { id, status, reason, detail } : { id, status, detail };

function bindChecks(b: Record<string, unknown>, out: LinkCheck[]): void {
  const bind = isObj(b.bind) ? b.bind : null;
  if (!bind) {
    // Emit every check id even when the input is absent. A report whose SHAPE
    // varies with its input lets a missing check read as a passing one.
    out.push(ck("bind_strength_level", "unchecked", "no bind section to verify", "absent"));
    out.push(ck("bind_leaf_recomputed", "unchecked", "no bind section to verify", "absent"));
    return;
  }
  const strength = isStr(bind.strength) ? bind.strength : null;
  const level = isStr(bind.evidence_level) ? bind.evidence_level : null;
  if (strength && level) {
    const expected = BIND_LEVELS[strength];
    out.push(expected === undefined
      ? ck("bind_strength_level", "failed", `unknown bind strength ${JSON.stringify(strength)}`)
      : expected === level
        ? ck("bind_strength_level", "verified", `strength ${strength} matches evidence_level ${level}`)
        : ck("bind_strength_level", "failed",
            `strength ${strength} requires evidence_level ${expected}, bundle says ${level}`));
  } else {
    out.push(ck("bind_strength_level", "unchecked", "bind.strength/evidence_level absent", "absent"));
  }

  // The real one: recompute the v1 leaf from the requirements the bundle
  // publishes. If the bundle's bind leaf was copied from a different offer,
  // this is where it stops being credible.
  const req = isObj(b.requirements) ? (b.requirements as ResourceBindReq) : null;
  const claimed = bind.leaf_hash;
  if (!req) {
    out.push(ck("bind_leaf_recomputed", "unchecked",
      "bundle publishes no requirements projection, so bind.leaf_hash is unverifiable", "absent"));
    return;
  }
  if (claimed === null || claimed === undefined) {
    out.push(ck("bind_leaf_recomputed", "unchecked",
      "bind.leaf_hash is null (unbound/refuse path): nothing to recompute", "absent"));
    return;
  }
  if (!isHex64(claimed)) {
    out.push(ck("bind_leaf_recomputed", "unchecked", "bind.leaf_hash is not 64-hex", "malformed"));
    return;
  }
  let recomputed: string;
  try {
    recomputed = resourceBindLeafHash(req);
  } catch (e) {
    out.push(ck("bind_leaf_recomputed", "unchecked",
      `resourceBindLeafHash threw: ${e instanceof Error ? e.message : String(e)}`, "malformed"));
    return;
  }
  out.push(recomputed === String(claimed).toLowerCase()
    ? ck("bind_leaf_recomputed", "verified",
        "bind.leaf_hash equals resourceBindLeafHash(requirements) — the bind covers THIS offer")
    : ck("bind_leaf_recomputed", "failed",
        `bind.leaf_hash does not match the published requirements (recomputed ${recomputed.slice(0, 16)}…)`));
}

/** spend-control.ts:180 builds the receipt from the SAME ResourceBindDecision
 *  as the bind, so a resource_bound receipt leaf must equal the bind leaf. */
function receiptChecks(b: Record<string, unknown>, out: LinkCheck[]): void {
  const r = isObj(b.receipt) ? b.receipt : null;
  if (!r) {
    out.push(ck("receipt_binds_bind", "unchecked", "no receipt section to verify", "absent"));
    return;
  }

  if (r.fact_type !== "resource_bound") {
    out.push(ck("receipt_binds_bind", "unchecked",
      `receipt.fact_type ${JSON.stringify(r.fact_type ?? null)} carries no bind linkage`, "absent"));
    return;
  }
  const bind = isObj(b.bind) ? b.bind : null;
  const receiptLeaf = isStr(r.leaf_hash) ? r.leaf_hash : isStr(r.leaf) ? r.leaf : null;
  if (!bind || !isStr(bind.leaf_hash)) {
    out.push(ck("receipt_binds_bind", "failed",
      "receipt claims fact_type resource_bound but the bundle carries no bind leaf to anchor it"));
    return;
  }
  if (!receiptLeaf) {
    out.push(ck("receipt_binds_bind", "failed",
      "receipt claims fact_type resource_bound but publishes no leaf"));
    return;
  }
  out.push(receiptLeaf.toLowerCase() === bind.leaf_hash.toLowerCase()
    ? ck("receipt_binds_bind", "verified", "receipt leaf equals bind leaf (spend-control.ts:180)")
    : ck("receipt_binds_bind", "failed",
        "receipt leaf differs from bind leaf: the receipt authorizes a different offer"));
}

/**
 * The outcome attestation is the only cryptographic object in the bundle.
 * Two independent things are checkable and they prove DIFFERENT amounts:
 *
 *  - leaf recomputation: keccak256 over the published preimage must equal
 *    the published leaf. Proves the leaf describes THIS decision. Needs
 *    js-sha3 (optional peer), so it can legitimately be unchecked.
 *  - signature: Ed25519 over the leaf. Verifying against the bundle's OWN
 *    `signing_pubkey` proves only INTERNAL CONSISTENCY — a forger who swaps
 *    both key and signature still passes. Authenticity requires the
 *    operator's independently published key, so pass `expectedPubkeyB58`.
 */
function outcomeChecks(
  b: Record<string, unknown>, out: LinkCheck[], expectedPubkeyB58?: string,
): void {
  const o = isObj(b.outcomeAttestation) ? b.outcomeAttestation : null;
  if (!o) {
    for (const id of ["outcome_leaf_recomputed", "outcome_signature", "outcome_binds_decision"]) {
      out.push(ck(id, "unchecked", "no outcomeAttestation section", "absent"));
    }
    return;
  }
  const pre = isObj(o.preimage) ? o.preimage : null;
  const leaf = isStr(o.leaf) ? o.leaf.toLowerCase().replace(/^0x/, "") : null;

  if (!pre || !leaf) {
    out.push(ck("outcome_leaf_recomputed", "unchecked",
      "attestation publishes no preimage (or no leaf): the leaf is an opaque blob here", "absent"));
  } else {
    const fields = {
      decisionId: String(pre.decision_id ?? ""),
      counterparty: String(pre.counterparty ?? ""),
      verdict: pre.verdict,
      outcome: pre.outcome,
      timestampUnix: pre.timestamp_unix,
      intentHash: (pre.intent_hash ?? null) as string | null,
      payer: (pre.payer ?? null) as string | null,
      settlementTx: (pre.settlement_tx ?? null) as string | null,
      preflightId: (pre.preflight_id ?? null) as number | null,
    } as DecisionOutcomeFields;
    try {
      const recomputed = computeDecisionOutcomeLeafV1(fields).toString("hex");
      out.push(recomputed === leaf
        ? ck("outcome_leaf_recomputed", "verified",
            "keccak256(preimage) equals the published leaf")
        : ck("outcome_leaf_recomputed", "failed",
            `leaf does not match its own preimage (recomputed ${recomputed.slice(0, 16)}…)`));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push(ck("outcome_leaf_recomputed", "unchecked", msg,
        /js-sha3/.test(msg) ? "dependency_missing" : "malformed"));
    }
  }

  const pubkey = expectedPubkeyB58 ?? (isStr(o.signing_pubkey) ? o.signing_pubkey : null);
  if (!isStr(o.signature) || !pubkey || !leaf) {
    out.push(ck("outcome_signature", "unchecked",
      "attestation is unsigned or carries no verification key", "absent"));
  } else {
    let valid: boolean;
    try {
      valid = verifyOutcomeAttestationSignature(
        { leaf: o.leaf as string, signature: o.signature }, pubkey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push(ck("outcome_signature", "unchecked", msg,
        /@scure\/base/.test(msg) ? "dependency_missing" : "malformed"));
      return;
    }
    if (!valid) {
      out.push(ck("outcome_signature", "failed", "Ed25519 signature does not verify over the leaf"));
    } else if (expectedPubkeyB58) {
      out.push(ck("outcome_signature", "verified",
        "signature verifies against the caller-supplied operator key (authentic)"));
    } else {
      out.push({
        ...ck("outcome_signature", "verified",
          "signature verifies against the bundle's OWN signing_pubkey — self-consistent " +
          "only, NOT authenticity; re-run with the operator's independently published key"),
        selfAnchored: true,
      });
    }
  }

  // Does the attestation describe the decision this bundle is about?
  const d = isObj(b.decision) ? b.decision : null;
  const claimedId = d && isStr(d.decisionId) ? d.decisionId : null;
  const preId = pre && isStr(pre.decision_id) ? pre.decision_id : null;
  if (!claimedId || !preId) {
    out.push(ck("outcome_binds_decision", "unchecked",
      "decision.decisionId or preimage.decision_id absent", "absent"));
  } else {
    out.push(claimedId === preId
      ? ck("outcome_binds_decision", "verified",
          "attestation preimage names the same decisionId as the bundle decision")
      : ck("outcome_binds_decision", "failed",
          "attestation is for a different decisionId than the bundle's decision"));
  }
}

export function verifyBundleLinkage(value: unknown, expectedPubkeyB58?: string): LinkageReport {
  if (!isObj(value)) {
    return { ok: false, checks: [ck("bundle_parsed", "failed", "bundle is not a JSON object")] };
  }
  const checks: LinkCheck[] = [];
  bindChecks(value, checks);
  receiptChecks(value, checks);
  outcomeChecks(value, checks, expectedPubkeyB58);
  return { ok: !checks.some((c) => c.status === "failed"), checks };
}

/* ------------------------------------------------------------------ */
/* Part 5: the report — every claim labelled, nothing left implicit     */
/* ------------------------------------------------------------------ */

export type ClaimLabel = "MACHINE_VERIFIED" | "REFUTED" | "ASSERTED";
/** MACHINE_VERIFIED: checked and HOLDS. REFUTED: checked and FAILED.
 *  ASSERTED: not establishable here. The label must track the OUTCOME —
 *  labelling a failed check MACHINE_VERIFIED is exactly the over-claiming
 *  this module exists to prevent. */

export type BundleClaim = {
  claim: string;
  label: ClaimLabel;
  /** For MACHINE_VERIFIED: what computation established it. For ASSERTED:
   *  why this verifier cannot establish it, so the gap is explicit. */
  evidence: string;
};

export type EvidenceVerificationReport = {
  schema: typeof EVIDENCE_VERIFICATION_SCHEMA;
  /** Verifier's overall verdict: well-formed AND consistent AND scrub-clean
   *  AND no failed linkage. Unchecked linkage does not make it true. */
  ok: boolean;
  /** sha256 over key-sorted JSON. Deterministic: no clock, no network, so two
   *  operators verifying the same bytes print the same digest. */
  bundleDigest: string;
  validation: ValidationReport;
  scrub: ScrubReport;
  linkage: LinkageReport;
  claims: BundleClaim[];
};

/** Key-sorted JSON so the digest is stable across producers. Tolerates null
 *  (the package's canonicalJson deliberately does not, and bundles carry it). */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

const claim = (c: string, label: ClaimLabel, evidence: string): BundleClaim => ({ claim: c, label, evidence });

function statusOf(l: LinkageReport, id: string): LinkCheck | undefined {
  return l.checks.find((c) => c.id === id);
}

function linked(l: LinkageReport, id: string, yes: string, no: string): BundleClaim {
  const c = statusOf(l, id);
  // A self-anchored pass proves the document agrees with itself and nothing
  // more, so it stays ASSERTED however green the check looks.
  if (c?.status === "verified" && c.selfAnchored) {
    return claim(id, "ASSERTED", `${c.detail}`);
  }
  return c?.status === "verified"
    ? claim(id, "MACHINE_VERIFIED", `${yes} (${c.detail})`)
    : claim(id, "ASSERTED", `${no} (${c ? `${c.status}: ${c.detail}` : "check absent"})`);
}

/**
 * The whole point of this module. Every statement a reader might take away
 * from the bundle is placed in exactly one of two buckets, and the ASSERTED
 * bucket carries the reason it could not be promoted.
 */
export function classifyBundleClaims(
  bundle: Record<string, unknown>, v: ValidationReport, s: ScrubReport, l: LinkageReport,
): BundleClaim[] {
  const out: BundleClaim[] = [
    claim("well_formed_v1", v.ok ? "MACHINE_VERIFIED" : "REFUTED",
      v.ok ? "schema, types and enums checked by validateEvidenceBundle"
           : `validateEvidenceBundle REJECTED this bundle: ${v.errors.filter((e) => e.severity === "error").map((e) => e.code).join(", ")}`),
    claim("internally_consistent",
      v.errors.some((e) => e.severity === "error" &&
        /refused_but_signed|outcome_contradicts|approved_block/.test(e.code))
        ? "REFUTED" : "MACHINE_VERIFIED",
      v.errors.some((e) => e.severity === "error" &&
        /refused_but_signed|outcome_contradicts|approved_block/.test(e.code))
        ? "CONTRADICTION FOUND — approved/signer/outcome disagree"
        : "approved vs signerInvocations vs outcome cross-checked, no contradiction"),
    claim("scrub_clean", s.clean ? "MACHINE_VERIFIED" : "REFUTED",
      s.clean
        ? `${s.scannedBytes} bytes value-scanned; 0 unwaived secret-shaped values`
        : `NOT CLEAN: ${s.violations.map((f) => `${f.kind}@${f.path}`).join(", ")}`),
    claim("lineage_honest",
      v.errors.some((e) => e.code === "lineage_forged" || e.code === "external_run_asserted")
        ? "REFUTED" : "MACHINE_VERIFIED",
      v.errors.some((e) => e.code === "lineage_forged" || e.code === "external_run_asserted")
        ? "lineage claim REJECTED"
        : "lineage cross-checked against the integration id; no EXTERNAL_RUN asserted anywhere"),
  ];

  // Derived vs asserted redactions.
  out.push(Array.isArray(bundle.redactionsDerived) || bundle.redactionsDerived === true
    ? claim("redactions_derived", "MACHINE_VERIFIED",
        "bundle records redactions produced by the scrubber, and the value scan " +
        "independently confirms nothing of those classes survived")
    : claim("redactions_derived", "ASSERTED",
        "redactions[] is a hardcoded list the producer asserts; it is not evidence " +
        "that those classes were present or removed. The value scan above is."));

  // The headline safety claim. Be exact about what a document can prove.
  const d = isObj(bundle.decision) ? bundle.decision : null;
  const n = d && isInt0(d.signerInvocations) ? d.signerInvocations : null;
  out.push(claim("signer_never_invoked", "ASSERTED",
    n === 0
      ? "the bundle RECORDS signerInvocations:0 and that number is coherent with " +
        "approved:false, but a document cannot prove a function was never called — " +
        "only re-running the harness (runGateAdoptionProof) observes the signer stub"
      : `bundle records signerInvocations:${n ?? "unknown"}`));

  out.push(claim("transcript_assertions", "ASSERTED",
    "the bundle carries the transcript's assertion booleans and stepCount but not " +
    "its steps, so selectedRequirementReachedHook / blockedPathNeverInvokesSigner " +
    "cannot be re-derived from the bundle alone"));

  out.push(linked(l, "bind_leaf_recomputed",
    "bind covers the exact 402 offer the bundle publishes", "bind leaf is a pass-through blob here"));
  out.push(linked(l, "receipt_binds_bind",
    "receipt authorizes the same offer the bind covers", "receipt leaf not anchored to a bind"));
  out.push(linked(l, "outcome_leaf_recomputed",
    "attestation leaf recomputed from its own preimage", "attestation leaf not recomputed"));
  out.push(linked(l, "outcome_signature",
    "Ed25519 signature verified", "attestation signature not verified"));

  out.push(claim("external_adoption", "ASSERTED",
    "NEVER machine-verifiable from a locally produced bundle: EXTERNAL_RUN requires " +
    "the server-side join in the acceptance doc. This artifact is correlation evidence."));
  return out;
}

/** One call a foreign operator runs over a published bundle. Offline, deterministic. */
export function verifyEvidenceBundle(
  value: unknown, opts: { expectedOutcomePubkeyB58?: string } = {},
): EvidenceVerificationReport {
  const validation = validateEvidenceBundle(value);
  const scrub = verifyScrubClean(value);
  const linkage = verifyBundleLinkage(value, opts.expectedOutcomePubkeyB58);
  const bundle = isObj(value) ? value : {};
  return {
    schema: EVIDENCE_VERIFICATION_SCHEMA,
    ok: validation.ok && scrub.clean && linkage.ok,
    bundleDigest: createHash("sha256").update(stableStringify(value)).digest("hex"),
    validation,
    scrub,
    linkage,
    claims: classifyBundleClaims(bundle, validation, scrub, linkage),
  };
}

/* ------------------------------------------------------------------ */
/* Part 6: the producer's scrubber — SAME rules the scanner enforces    */
/*                                                                     */
/* Exported so exportEvidenceBundle() removes secrets using exactly the */
/* patterns verifyScrubClean() looks for. One definition, so a producer */
/* and a verifier can never drift into "scrubbed, but not by the rule   */
/* the checker uses".                                                   */
/* ------------------------------------------------------------------ */

/**
 * Paths whose string value is published verbatim and must NOT be masked:
 * hashes, signatures, the offer projection. Everything else is free text,
 * where a secret can hide under an innocuous key name — so masking is
 * fail-closed and this allowlist is the only way out.
 */
export const PUBLISHED_VERBATIM =
  /^(?:requirements\.(?:payTo|asset|network|resource|scheme|amount)|bind\.leaf_hash|receipt\.(?:leaf|leaf_hash)|ledger\.lastHash|outcomeAttestation\.(?:leaf|signature|signing_pubkey|preimage\..*))$/;

/**
 * Replace every secret-shaped run in `text` with a typed marker.
 * Returns the masked text plus the kinds actually removed, so the caller can
 * DERIVE its redaction list instead of asserting one.
 */
export function maskSecretsInText(text: string): { text: string; removed: SecretKind[] } {
  const removed: SecretKind[] = [];
  let out = text;
  for (const rule of RULES) {
    const g = new RegExp(rule.re.source, `${rule.re.flags.replace(/g/g, "")}g`);
    if (!g.test(out)) continue;
    g.lastIndex = 0;
    out = out.replace(g, `<redacted:${rule.kind}>`);
    removed.push(rule.kind);
  }
  return { text: out, removed };
}

/* ------------------------------------------------------------------ */
/* Part 7: CLI — the thing a foreign operator actually runs             */
/* ------------------------------------------------------------------ */

/** Render a report for humans. Machine consumers should read the JSON. */
export function formatVerificationReport(r: EvidenceVerificationReport): string {
  const L: string[] = [];
  L.push(`twzrd evidence verification — ${r.ok ? "PASS" : "FAIL"}`);
  L.push(`bundle sha256: ${r.bundleDigest}`);
  L.push("");
  L.push(`schema/consistency : ${r.validation.ok ? "ok" : "REJECTED"}`);
  for (const e of r.validation.errors) {
    L.push(`  [${e.severity === "error" ? "ERROR" : "warn "}] ${e.code} @ ${e.path}: ${e.message}`);
  }
  L.push(`scrub-clean        : ${r.scrub.clean ? `ok (${r.scrub.scannedBytes} bytes scanned)` : "LEAK"}`);
  for (const f of r.scrub.violations) L.push(`  [ERROR] ${f.kind} @ ${f.path} ${f.preview}`);
  for (const f of r.scrub.waived) L.push(`  [waived:${f.waivedBy}] ${f.kind} @ ${f.path}`);
  L.push(`linkage            : ${r.linkage.ok ? "ok" : "MISMATCH"}`);
  for (const c of r.linkage.checks) {
    L.push(`  ${c.status === "verified" ? "[ok]   " : c.status === "failed" ? "[FAIL] " : "[skip] "}` +
      `${c.id}${c.reason ? ` (${c.reason})` : ""}: ${c.detail}`);
  }
  L.push("");
  L.push("claims:");
  for (const c of r.claims) L.push(`  ${c.label === "MACHINE_VERIFIED" ? "[MACHINE]" : "[ASSERTED]"} ${c.claim} — ${c.evidence}`);
  return L.join("\n");
}

/**
 * `twzrd-evidence-bundle --verify <bundle.json> [--expect-pubkey <b58>] [--json]`
 * Offline and deterministic: reads one local file, writes a verdict, exits
 * non-zero when the bundle does not verify.
 */
export async function mainVerify(argv: string[]): Promise<number> {
  const { readFileSync } = await import("node:fs");
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    process.stderr.write("usage: twzrd-evidence-bundle --verify <bundle.json> [--expect-pubkey <b58>] [--json]\n");
    return 2;
  }
  const i = argv.indexOf("--expect-pubkey");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    process.stderr.write(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const report = verifyEvidenceBundle(parsed, {
    expectedOutcomePubkeyB58: i >= 0 ? argv[i + 1] : undefined,
  });
  process.stdout.write(
    argv.includes("--json")
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatVerificationReport(report)}\n`,
  );
  return report.ok ? 0 : 1;
}

const isVerifyCli =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  /evidence-verify\.(js|ts)$/.test(process.argv[1]);
if (isVerifyCli) {
  mainVerify(process.argv.slice(2).filter((a) => a !== "--verify")).then(
    (code) => process.exit(code),
    (err) => { console.error(err); process.exit(1); },
  );
}
