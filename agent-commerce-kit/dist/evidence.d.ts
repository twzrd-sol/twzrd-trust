import type { AgentCommerceLoop } from "./types.js";
export interface EvidenceBundle {
    format: "twzrd.agent-commerce-evidence/1.0";
    exported_at: string;
    loop_id: string;
    activity: AgentCommerceLoop["activity"];
    outcome: {
        payment: string;
        delivery: string;
        attribution: string;
    };
    refs: string[];
    event_log_hash: string;
    loop: AgentCommerceLoop;
}
export declare function exportEvidence(loop: AgentCommerceLoop): EvidenceBundle;
