"""Dependency-light Python client for Agent Commerce Loop documents and receipts."""
from __future__ import annotations
import base64, copy, datetime, hashlib, json
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

CONTRACT_VERSION = "twzrd.agent-commerce-loop/1.0"

def _event(loop: dict, stage: str, data: dict | None = None) -> None:
    loop["events"].append({"sequence": len(loop["events"]), "stage": stage, "at": datetime.datetime.now(datetime.UTC).isoformat().replace("+00:00", "Z"), "data": data or {}})

def create_loop(*, loop_id: str, resource: dict, parties: dict, activity: str, price: dict) -> dict:
    if activity not in ("house", "sponsored", "external"): raise ValueError("invalid_activity")
    loop = {"contract_version": CONTRACT_VERSION, "loop_id": loop_id, "resource": copy.deepcopy(resource), "parties": copy.deepcopy(parties), "activity": activity, "price": copy.deepcopy(price), "policy": {"decision": "block", "reasons": ["policy_not_evaluated"], "preflight_ref": None}, "payment": {"status": "not_started", "intent_ref": None, "signature_ref": None, "settlement_ref": None}, "delivery": {"status": "not_started", "delivery_ref": None}, "receipt": None, "attribution": {"status": "unverified", "evidence_refs": []}, "events": []}
    _event(loop, "discover", {"resource_id": resource["id"]})
    return loop

def apply_policy(loop: dict, decision: str, reasons: list[str], preflight_ref: str) -> dict:
    if decision not in ("allow", "warn", "block"): raise ValueError("invalid_decision")
    _event(loop, "preflight", {"preflight_ref": preflight_ref})
    loop["policy"] = {"decision": decision, "reasons": list(reasons), "preflight_ref": preflight_ref}
    _event(loop, "policy_decision", {"decision": decision, "reasons": list(reasons)})
    if decision == "block": loop["payment"]["status"] = "blocked"
    return loop

def create_payment_intent(loop: dict) -> str:
    if loop["policy"]["decision"] == "block": raise ValueError("policy_block: payment intent and signature forbidden")
    bound = {key: loop[key] for key in ("loop_id", "resource", "parties", "price", "activity")}
    reference = "intent:sha256:" + hashlib.sha256(canonical_json(bound)).hexdigest()
    loop["payment"] = {"status": "intended", "intent_ref": reference, "signature_ref": None, "settlement_ref": None}
    _event(loop, "payment_intent", {"intent_ref": reference})
    return reference

def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

def _receipt_payload(loop: dict) -> dict:
    return {key: loop[key] for key in ("contract_version", "loop_id", "resource", "parties", "activity", "price", "policy", "payment", "delivery")}

def verify_receipt(loop: dict) -> bool:
    receipt = loop.get("receipt")
    if not receipt or receipt.get("algorithm") != "Ed25519": return False
    payload = _receipt_payload(loop)
    if hashlib.sha256(canonical_json(payload)).hexdigest() != receipt.get("payload_hash"): return False
    try:
        key = serialization.load_der_public_key(base64.b64decode(receipt["public_key"]))
        if not isinstance(key, Ed25519PublicKey): return False
        key.verify(base64.b64decode(receipt["signature"]), canonical_json(payload))
        return True
    except (ValueError, KeyError, TypeError): return False

def replay(loop: dict) -> dict:
    events = loop.get("events", [])
    if any(event.get("sequence") != index for index, event in enumerate(events)): raise ValueError("invalid_sequence")
    if not events or events[0].get("stage") != "discover": raise ValueError("replay_must_start_with_discover")
    return {"valid": True, "stages": [event["stage"] for event in events], "spend_attempts": 0}

def export_evidence(loop: dict) -> dict:
    return {"format": "twzrd.agent-commerce-evidence/1.0", "loop_id": loop["loop_id"], "activity": loop["activity"], "outcome": {"payment": loop["payment"]["status"], "delivery": loop["delivery"]["status"], "attribution": loop["attribution"]["status"]}, "refs": list(loop["attribution"]["evidence_refs"]), "event_log_hash": hashlib.sha256(canonical_json(loop["events"])).hexdigest(), "loop": copy.deepcopy(loop)}
