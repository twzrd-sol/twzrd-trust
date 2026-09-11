import { sha256 } from "./canonical.js";
import type { AgentCommerceLoop } from "./types.js";

export interface EvidenceBundle { format: "twzrd.agent-commerce-evidence/1.0"; exported_at: string; loop_id: string; activity: AgentCommerceLoop["activity"]; outcome: { payment: string; delivery: string; attribution: string }; refs: string[]; event_log_hash: string; loop: AgentCommerceLoop; }
export function exportEvidence(loop: AgentCommerceLoop): EvidenceBundle {
  return { format: "twzrd.agent-commerce-evidence/1.0", exported_at: new Date().toISOString(), loop_id: loop.loop_id, activity: loop.activity, outcome: { payment: loop.payment.status, delivery: loop.delivery.status, attribution: loop.attribution.status }, refs: [...loop.attribution.evidence_refs], event_log_hash: sha256(loop.events), loop: structuredClone(loop) };
}
