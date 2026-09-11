export declare const CONTRACT_VERSION: "twzrd.agent-commerce-loop/1.0";
export type Decision = "allow" | "warn" | "block";
export type ActivityClass = "house" | "sponsored" | "external";
export type CustodyClass = "self_custody" | "facilitated_non_custodial" | "facilitator_custody" | "unknown";
export type Stage = "discover" | "preflight" | "policy_decision" | "payment_intent" | "settlement" | "delivery" | "signed_receipt" | "outcome_evidence";
export interface LoopEvent {
    sequence: number;
    stage: Stage;
    at: string;
    data: Record<string, unknown>;
}
export interface SignedReceipt {
    receipt_id: string;
    loop_id: string;
    payload_hash: string;
    signer: string;
    algorithm: "Ed25519";
    public_key: string;
    signature: string;
    settlement_ref: string;
    issued_at: string;
}
export interface AgentCommerceLoop {
    contract_version: typeof CONTRACT_VERSION;
    loop_id: string;
    resource: {
        id: string;
        uri: string;
        version: string;
    };
    parties: {
        payer: string;
        seller: string;
        facilitator: string | null;
        custody: CustodyClass;
    };
    activity: ActivityClass;
    price: {
        amount: string;
        asset: string;
        network: string;
    };
    policy: {
        decision: Decision;
        reasons: string[];
        preflight_ref: string | null;
    };
    payment: {
        status: "not_started" | "blocked" | "intended" | "signed" | "settled" | "failed";
        intent_ref: string | null;
        signature_ref: string | null;
        settlement_ref: string | null;
        failure?: string | null;
    };
    delivery: {
        status: "not_started" | "delivered" | "failed";
        delivery_ref: string | null;
        failure?: string | null;
    };
    receipt: SignedReceipt | null;
    attribution: {
        status: "unverified" | "verified" | "failed";
        evidence_refs: string[];
    };
    events: LoopEvent[];
}
export interface CreateLoopInput {
    loop_id: string;
    resource: AgentCommerceLoop["resource"];
    parties: AgentCommerceLoop["parties"];
    activity: ActivityClass;
    price: AgentCommerceLoop["price"];
}
