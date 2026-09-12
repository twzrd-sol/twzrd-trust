/**
 * Attribution-safe evidence bundle — the learn step of the commerce loop.
 *
 * Joins artifacts already produced by the gate (transcript, decision, bind-v1,
 * V6/ACK-Pay receipt, ledger slice, refuse attestation) into one export an
 * operator can publish without forensic work. Redacts secrets by construction.
 *
 * This is correlation / journey evidence. It is NOT EXTERNAL_RUN by itself.
 */

import { writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

import {
  ADOPTION_TRANSCRIPT_SCHEMA,
  isInternalIntegration,
  runGateAdoptionProof,
  type GateAdoptionLineage,
  type GateAdoptionTranscript,
} from "./adoption-proof.js";
import {
  PUBLISHED_VERBATIM,
  maskSecretsInText,
  type SecretKind,
} from "./evidence-verify.js";
import { CLIENT_VERSION } from "./version.js";

export const EVIDENCE_BUNDLE_SCHEMA = "twzrd.evidence_bundle.v1" as const;

const SECRET_KEY =
  /^(private[_-]?key|secret|seed|mnemonic|password|authorization|keypair|api[_-]?key)$/i;

const NOT_EXTERNAL = [
  "package_download_counts",
  "preflight_hits_alone",
  "self_authored_run_id_alone",
  "twzrd_dogfood_or_ci",
  "house_or_sponsored_wallets",
  "this_bundle_alone_without_server_side_join",
] as const;

/** Where decision.signerInvocations was read from. Without this a reviewer
 *  cannot tell whether 0 covers the whole run or one cherry-picked step. */
export type SignerProvenance = {
  source: "transcript_step" | "explicit_caller" | "unknown";
  /** Transcript step the count was read from. */
  step?: string;
  transcriptSchema?: string;
  stepsCounted?: number;
  stepsTotal?: number;
  /** Sum across EVERY step, so a partial reading cannot hide a nonzero one. */
  allStepsSignerInvocations?: number;
};

/** The 402 offer, projected exactly as resourceBindLeafHash() consumes it.
 *  Published so bind.leaf_hash is recomputable instead of a pass-through blob. */
export type EvidenceRequirements = {
  payTo: string;
  network: string;
  amount: string;
  asset: string;
  resource: string;
  scheme: string;
};

export type EvidenceDecision = {
  verdict: string;
  approved: boolean;
  reason?: string;
  signerInvocations: number;
  preflightId?: number | null;
  decisionId?: string | null;
  signerProvenance?: SignerProvenance;
};

export type EvidenceBind = {
  strength?: string;
  evidence_level?: string;
  leaf_hash?: string | null;
  fact_type?: string;
};

export type EvidenceReceipt = {
  id?: string;
  leaf?: string;
  /** spend-control.ts:180 emits the receipt from the SAME ResourceBindDecision
   *  as the bind, so for fact_type "resource_bound" this equals bind.leaf_hash. */
  leaf_hash?: string | null;
  fact_type?: string;
  ack_pay?: boolean;
};

export type EvidenceLedgerSlice = {
  spendRows: number;
  lastHash?: string;
  verdicts: Array<{
    outcome: string;
    reason_codes?: string[];
    signer_invocations?: number;
  }>;
};

export type EvidenceOutcomeAttestation = {
  outcome: string;
  leaf?: string;
  signing_pubkey?: string | null;
  /** Published so a relying party can recompute keccak256(preimage) == leaf.
   *  Without it the leaf is an opaque blob and nothing about it is checkable. */
  preimage?: Record<string, unknown>;
  signature?: string | null;
};

export type EvidenceBundle = {
  schema: typeof EVIDENCE_BUNDLE_SCHEMA;
  package: "twzrd-x402-gate";
  packageVersion: string;
  exportedAt: string;
  attribution: { integration: string; runId: string };
  lineage: GateAdoptionLineage;
  notExternalRunProof: string[];
  decision: EvidenceDecision;
  transcript?: Pick<
    GateAdoptionTranscript,
    "schema" | "mode" | "ok" | "assertions" | "proofKind"
  > & { stepCount: number };
  bind?: EvidenceBind;
  receipt?: EvidenceReceipt;
  ledger: EvidenceLedgerSlice;
  outcomeAttestation?: EvidenceOutcomeAttestation;
  requirements?: EvidenceRequirements;
  /** DERIVED: one entry per value this export actually removed, as
   *  "<rule>@<path>". Empty means nothing matched — never "we did not look". */
  redactions: string[];
  /** Marks redactions[] as produced by the scrubber rather than asserted. */
  redactionsDerived: true;
  /** Set when an explicit lineage flag was refused. See defect note below. */
  lineageCoerced?: { from: GateAdoptionLineage; to: GateAdoptionLineage; reason: string };
};

export type ExportEvidenceBundleOptions = {
  attribution: { integration: string; runId: string };
  lineage?: GateAdoptionLineage;
  decision?: EvidenceDecision;
  transcript?: GateAdoptionTranscript;
  bind?: EvidenceBind;
  receipt?: EvidenceReceipt;
  ledger?: EvidenceLedgerSlice;
  outcomeAttestation?: EvidenceOutcomeAttestation;
  requirements?: EvidenceRequirements;
};

/**
 * Scrub by NAME *and* by VALUE, recording every removal.
 *
 * The old redactor only dropped keys whose NAME matched SECRET_KEY, then the
 * export asserted a fixed redactions[] list regardless of what happened. A
 * wallet under an innocuous key survived that: a real export of this package
 * put a base58 payTo in `decision.reason` while the bundle claimed
 * "ledger_pay_to_and_amounts" had been redacted.
 *
 * So: every string that is not on the publish allowlist is masked with the
 * SAME rules the verifier scans for (maskSecretsInText), and each removal is
 * appended to `removed` — which becomes redactions[]. The list is now a
 * receipt of work done, not a promise.
 */
function scrubValue(value: unknown, path: string, removed: string[]): unknown {
  if (typeof value === "string") {
    if (PUBLISHED_VERBATIM.test(path)) return value;
    const masked = maskSecretsInText(value);
    for (const kind of masked.removed) removed.push(`${kind}@${path}`);
    return masked.text;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => scrubValue(item, `${path}[${i}]`, removed));
  }
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (SECRET_KEY.test(key)) {
      removed.push(`secret_key_name@${next}`);
      continue;
    }
    out[key] = scrubValue(child, next, removed);
  }
  return out;
}

/** Public for tests: what would this export strip, and from where? */
export function scrubForEvidence<T>(value: T): { value: T; redactions: string[] } {
  const removed: string[] = [];
  const scrubbed = scrubValue(value, "", removed) as T;
  return { value: scrubbed, redactions: [...new Set(removed)].sort() };
}

/** Kinds this module can remove; re-exported so callers can reason about coverage. */
export type EvidenceRedactionKind = SecretKind | "secret_key_name";

export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function exportEvidenceBundle(opts: ExportEvidenceBundleOptions): EvidenceBundle {
  const integration = opts.attribution.integration.trim();
  const runId = opts.attribution.runId.trim();
  if (!integration || !runId) {
    throw new Error("[twzrd-x402-gate] evidence bundle requires attribution.integration and attribution.runId");
  }

  const transcript = opts.transcript;
  const block = transcript?.steps.find((s) => s.name === "block_path");
  const decision: EvidenceDecision = opts.decision ?? {
    verdict: block?.verdict ?? "unknown",
    approved: block?.approved ?? false,
    reason: block?.reason,
    signerInvocations: block?.signerInvocations ?? 0,
    // The count above is the BLOCK step's. Record that, plus the whole-run sum,
    // so a reader cannot mistake one step's 0 for the run's 0.
    signerProvenance: transcript
      ? {
          source: "transcript_step",
          step: "block_path",
          transcriptSchema: transcript.schema,
          stepsCounted: block ? 1 : 0,
          stepsTotal: transcript.steps.length,
          allStepsSignerInvocations: transcript.steps.reduce(
            (n, st) => n + (st.signerInvocations ?? 0), 0),
        }
      : { source: "unknown" },
  };
  if (opts.decision && !opts.decision.signerProvenance) {
    decision.signerProvenance = { source: "explicit_caller" };
  }

  /**
   * LINEAGE HONESTY.
   *
   * adoption-proof.ts resolves lineage as
   *   `opts.lineage ?? (isInternalIntegration(integration) ? "dogfood" : ...)`
   * so the explicit option wins unconditionally and isInternalIntegration()
   * is only a DEFAULT, never a GUARD: an id like "twzrd-dogfood-internal-ci-"
   * still emits lineage:"external_candidate" when the flag is passed. That
   * defeats the notExternalRunProof apparatus with one argument.
   *
   * The bundle layer refuses it. A self-authored run is never external, and
   * the coercion is RECORDED rather than silently applied.
   */
  const requested = opts.lineage ?? transcript?.lineage;
  const internal = isInternalIntegration(integration);
  const defaulted: GateAdoptionLineage = internal ? "dogfood" : "external_candidate";
  let lineage: GateAdoptionLineage = requested ?? defaulted;
  let lineageCoerced: EvidenceBundle["lineageCoerced"];
  if (lineage === "external_candidate" && internal) {
    lineageCoerced = {
      from: "external_candidate",
      to: "dogfood",
      reason:
        `integration ${JSON.stringify(integration)} matches the internal-integration ` +
        "predicate; an explicit lineage flag is not evidence of an external operator",
    };
    lineage = "dogfood";
  }

  const req = opts.requirements ?? (block
    ? {
        payTo: String(block.selectedRequirements.payTo ?? ""),
        network: String(block.selectedRequirements.network ?? ""),
        amount: String(block.selectedRequirements.amount ?? ""),
        asset: String(block.selectedRequirements.asset ?? ""),
        resource: String(block.selectedRequirements.resource ?? ""),
        scheme: String(block.selectedRequirements.scheme ?? ""),
      }
    : undefined);

  const scrubbed = scrubForEvidence({
    schema: EVIDENCE_BUNDLE_SCHEMA,
    package: "twzrd-x402-gate" as const,
    packageVersion: CLIENT_VERSION,
    exportedAt: new Date().toISOString(),
    attribution: { integration, runId },
    lineage,
    notExternalRunProof: [...NOT_EXTERNAL],
    decision,
    transcript: transcript
      ? {
          schema: transcript.schema,
          mode: transcript.mode,
          ok: transcript.ok,
          assertions: transcript.assertions,
          proofKind: transcript.proofKind,
          stepCount: transcript.steps.length,
        }
      : undefined,
    bind: opts.bind,
    receipt: opts.receipt,
    ledger: opts.ledger ?? { spendRows: 0, verdicts: [] },
    outcomeAttestation: opts.outcomeAttestation,
    requirements: req,
    ...(lineageCoerced ? { lineageCoerced } : {}),
  });
  // redactions is DERIVED from the scrub above, so it can never claim a
  // removal that did not happen — nor stay silent about one that did.
  return { ...scrubbed.value, redactions: scrubbed.redactions, redactionsDerived: true };
}

export function writeEvidenceBundle(bundle: EvidenceBundle, filePath: string): void {
  writeFileSync(filePath, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function exportEvidenceBundleFromAdoptionProof(opts: {
  integration?: string;
  runId?: string;
  lineage?: GateAdoptionLineage;
}): Promise<EvidenceBundle> {
  const integration = opts.integration ?? "demo-commerce-kit";
  const runId = opts.runId ?? randomUUID();
  const transcript = await runGateAdoptionProof({
    integration,
    runId,
    lineage: opts.lineage,
  });
  if (transcript.schema !== ADOPTION_TRANSCRIPT_SCHEMA) {
    throw new Error("[twzrd-x402-gate] unexpected adoption transcript schema");
  }
  return exportEvidenceBundle({
    attribution: { integration, runId },
    lineage: transcript.lineage,
    transcript,
  });
}

export async function main(argv = process.argv.slice(2)): Promise<EvidenceBundle> {
  const arg = (name: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const bundle = await exportEvidenceBundleFromAdoptionProof({
    integration: arg("--integration", process.env.TWZRD_ATTRIBUTION_INTEGRATION),
    runId: arg("--run-id", process.env.TWZRD_ATTRIBUTION_RUN_ID),
  });
  const out = arg("--out");
  if (out) writeEvidenceBundle(bundle, out);
  else console.log(JSON.stringify(bundle, null, 2));
  return bundle;
}

const isCli =
  typeof process.argv[1] === "string" &&
  /evidence-bundle\.(js|ts)$/.test(process.argv[1]);
if (isCli) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
