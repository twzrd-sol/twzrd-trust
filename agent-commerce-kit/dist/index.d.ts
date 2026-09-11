import { type AgentCommerceLoop, type CreateLoopInput, type Decision, type SignedReceipt, type Stage } from "./types.js";
export * from "./types.js";
export * from "./evidence.js";
export declare function createLoop(input: CreateLoopInput): AgentCommerceLoop;
export declare function applyPolicy(loop: AgentCommerceLoop, decision: Decision, reasons: string[], preflightRef: string): AgentCommerceLoop;
export declare function createPaymentIntent(loop: AgentCommerceLoop): string;
export declare function markPaymentSigned(loop: AgentCommerceLoop, signatureRef: string): void;
export declare function markPaymentFailed(loop: AgentCommerceLoop, reason: string): void;
export declare function markSettled(loop: AgentCommerceLoop, settlementRef: string): void;
export declare function markDelivery(loop: AgentCommerceLoop, delivered: boolean, referenceOrReason: string): void;
export declare function issueReceipt(loop: AgentCommerceLoop, privateKeyPem: string, signer: string): SignedReceipt;
export declare function verifyReceipt(loop: AgentCommerceLoop): boolean;
export declare function replay(events: AgentCommerceLoop["events"]): {
    valid: boolean;
    stages: Stage[];
    spend_attempts: 0;
};
