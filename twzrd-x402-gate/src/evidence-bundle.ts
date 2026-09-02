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
] as const;

export type EvidenceDecision = {
  verdict: string;
  approved: boolean;
  reason?: string;
  signerInvocations: number;
  preflightId?: number | null;
  decisionId?: string | null;
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
  redactions: string[];
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
};

function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = redactSecrets(child);
  }
  return out as T;
}

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
  };

  const lineage =
    opts.lineage ??
    transcript?.lineage ??
    (isInternalIntegration(integration) ? "dogfood" : "external_candidate");

  const redactions = [
    "secrets_and_private_keys",
    "ledger_pay_to_and_amounts",
    "buyer_wallet",
  ];

  return redactSecrets({
    schema: EVIDENCE_BUNDLE_SCHEMA,
    package: "twzrd-x402-gate",
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
    redactions,
  });
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
