import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson, sha256 } from "./canonical.js";
import { CONTRACT_VERSION, type AgentCommerceLoop, type CreateLoopInput, type Decision, type SignedReceipt, type Stage } from "./types.js";
export * from "./types.js";
export * from "./evidence.js";

const event = (loop: AgentCommerceLoop, stage: Stage, data: Record<string, unknown> = {}): void => {
  loop.events.push({ sequence: loop.events.length, stage, at: new Date().toISOString(), data });
};

export function createLoop(input: CreateLoopInput): AgentCommerceLoop {
  const loop: AgentCommerceLoop = {
    contract_version: CONTRACT_VERSION, ...input,
    policy: { decision: "block", reasons: ["policy_not_evaluated"], preflight_ref: null },
    payment: { status: "not_started", intent_ref: null, signature_ref: null, settlement_ref: null },
    delivery: { status: "not_started", delivery_ref: null }, receipt: null,
    attribution: { status: "unverified", evidence_refs: [] }, events: []
  };
  event(loop, "discover", { resource_id: input.resource.id });
  return loop;
}

export function applyPolicy(loop: AgentCommerceLoop, decision: Decision, reasons: string[], preflightRef: string): AgentCommerceLoop {
  event(loop, "preflight", { preflight_ref: preflightRef });
  loop.policy = { decision, reasons, preflight_ref: preflightRef };
  event(loop, "policy_decision", { decision, reasons });
  if (decision === "block") loop.payment.status = "blocked";
  return loop;
}

export function createPaymentIntent(loop: AgentCommerceLoop): string {
  if (loop.policy.decision === "block") throw new Error("policy_block: payment intent and signature forbidden");
  const ref = `intent:sha256:${sha256({ loop_id: loop.loop_id, resource: loop.resource, parties: loop.parties, price: loop.price, activity: loop.activity })}`;
  loop.payment = { status: "intended", intent_ref: ref, signature_ref: null, settlement_ref: null };
  event(loop, "payment_intent", { intent_ref: ref });
  return ref;
}

export function markPaymentSigned(loop: AgentCommerceLoop, signatureRef: string): void {
  if (loop.policy.decision === "block" || loop.payment.status !== "intended") throw new Error("payment_not_signable");
  loop.payment.status = "signed"; loop.payment.signature_ref = signatureRef;
}
export function markPaymentFailed(loop: AgentCommerceLoop, reason: string): void {
  loop.payment.status = "failed"; loop.payment.failure = reason;
  event(loop, "settlement", { status: "failed", reason });
}
export function markSettled(loop: AgentCommerceLoop, settlementRef: string): void {
  if (loop.payment.status !== "signed") throw new Error("payment_not_signed");
  loop.payment.status = "settled"; loop.payment.settlement_ref = settlementRef;
  event(loop, "settlement", { status: "settled", settlement_ref: settlementRef });
}
export function markDelivery(loop: AgentCommerceLoop, delivered: boolean, referenceOrReason: string): void {
  if (loop.payment.status !== "settled") throw new Error("payment_not_settled");
  loop.delivery = delivered ? { status: "delivered", delivery_ref: referenceOrReason } : { status: "failed", delivery_ref: null, failure: referenceOrReason };
  event(loop, "delivery", delivered ? { status: "delivered", delivery_ref: referenceOrReason } : { status: "failed", reason: referenceOrReason });
}

function receiptPayload(loop: AgentCommerceLoop) {
  return { contract_version: loop.contract_version, loop_id: loop.loop_id, resource: loop.resource, parties: loop.parties, activity: loop.activity, price: loop.price, policy: loop.policy, payment: loop.payment, delivery: loop.delivery };
}
export function issueReceipt(loop: AgentCommerceLoop, privateKeyPem: string, signer: string): SignedReceipt {
  if (loop.payment.status !== "settled" || !loop.payment.settlement_ref) throw new Error("unsettled_payment_has_no_receipt");
  const payload = receiptPayload(loop); const payloadHash = sha256(payload);
  const privateKey = createPrivateKey(privateKeyPem); const publicKey = createPublicKey(privateKey);
  const receipt: SignedReceipt = {
    receipt_id: `receipt:sha256:${payloadHash}`, loop_id: loop.loop_id, payload_hash: payloadHash, signer, algorithm: "Ed25519",
    public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64"),
    settlement_ref: loop.payment.settlement_ref, issued_at: new Date().toISOString()
  };
  loop.receipt = receipt; event(loop, "signed_receipt", { receipt_id: receipt.receipt_id });
  return receipt;
}
export function verifyReceipt(loop: AgentCommerceLoop): boolean {
  if (!loop.receipt) return false;
  const payload = receiptPayload(loop);
  const valid = sha256(payload) === loop.receipt.payload_hash && verify(null, Buffer.from(canonicalJson(payload)), createPublicKey({ key: Buffer.from(loop.receipt.public_key, "base64"), type: "spki", format: "der" }), Buffer.from(loop.receipt.signature, "base64"));
  loop.attribution.status = valid ? "verified" : "failed";
  if (valid && !loop.attribution.evidence_refs.includes(loop.receipt.receipt_id)) loop.attribution.evidence_refs.push(loop.receipt.receipt_id);
  event(loop, "outcome_evidence", { verification: loop.attribution.status });
  return valid;
}

export function replay(events: AgentCommerceLoop["events"]): { valid: boolean; stages: Stage[]; spend_attempts: 0 } {
  const stages = events.map((entry, index) => {
    if (entry.sequence !== index) throw new Error(`invalid_sequence:${entry.sequence}`);
    return entry.stage;
  });
  if (stages[0] !== "discover") throw new Error("replay_must_start_with_discover");
  return { valid: true, stages, spend_attempts: 0 };
}
