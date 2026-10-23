"""Fail-closed fold of the seven counsel roles.

Rules and the fields each role reads
------------------------------------
gate-drought
    Reads pressure_requests_override, empty_queue, deadline_pressure.
    An empty queue or a deadline does not loosen a refusal. An explicit
    request to override because of that pressure is itself a refusal.
inscription
    Reads parses_cleanly, signature_valid, signer_verified, signer_pinned,
    self_attested. A clean parse and a valid signature are not a credential.
    Unpinned or self-attested is not authority to pay.
settlement-not-delivery
    Reads settlement_visible, delivery_evidence. A visible settlement is not
    delivery, and payout needs delivery evidence whether or not anything
    settled.
familiar-face
    Reads known_name_vouches, unknown_key, unknown_key_verified. A known name
    is not a warrant for an unknown key. The vouch is recorded and never
    loosens the verdict.
collapsed-time
    Reads must_decide_now, receipt_thin. When the decision must happen now,
    hand it to a human, thin receipt or not. receipt_thin is recorded and
    never loosens that.
one-eyed-verifier
    Reads check_scope, reported_as_full_verification. A schema-only or partial
    check is not a full verification. The report is recorded and never
    upgrades a partial scope.
evidence-only
    Reads claim_wider_than_evidence, quick_integration_called_traction.
    A claim wider than the evidence is refused. A quick integration is not
    traction.

Allow only when every role allows. The first refusal stops the fold and names
the roles that were not reached. A hand-to-human does not stop it: the later
roles still run and any refusal outranks the handoff, so a human is never
handed a record that already fails. A flag that is present but not a boolean
is not evidence: None means "not evaluated", never "clean", so the role
reading it refuses and lists the flag as skipped. Files in the agent
directory that are not counsel roles are ignored; an unreadable file refuses.
"""

from __future__ import annotations

from pathlib import Path

ROLE_ORDER = (
    "gate-drought",
    "inscription",
    "settlement-not-delivery",
    "familiar-face",
    "collapsed-time",
    "one-eyed-verifier",
    "evidence-only",
)


class DiscoveryError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def agents_dir() -> Path:
    return Path(__file__).resolve().parents[1] / ".grok" / "agents"


def _parse_agent(text: str, path: Path) -> dict | None:
    """Parse one role file, or return None when it is not a counsel role.

    A broken counsel role also returns None, and discover_agents then refuses
    it as missing.
    """
    text = text.replace("\r\n", "\n")
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end < 0:
        return None
    meta: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if not line.strip() or ":" not in line:
            continue
        key, value = line.split(":", 1)
        meta[key.strip()] = value.strip().strip("\"'")
    body = text[end + len("\n---\n") :]
    if meta.get("name") not in ROLE_ORDER:
        return None
    if "order" not in meta:
        raise DiscoveryError(f"{path.name} is missing order")
    try:
        order = int(meta["order"])
    except ValueError:
        raise DiscoveryError(f"{path.name} order is not an integer") from None
    return {
        "name": meta["name"],
        "order": order,
        "body": body,
        "path": str(path),
    }


def discover_agents() -> list[dict]:
    """Load the seven counsel agents from the workspace discovery path."""
    root = agents_dir()
    if not root.is_dir():
        raise DiscoveryError(f"agent directory missing: {root}")
    found: dict[str, dict] = {}
    for path in sorted(root.glob("*.md")):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError) as exc:
            raise DiscoveryError(
                f"{path.name} is unreadable ({type(exc).__name__})"
            ) from None
        parsed = _parse_agent(text, path)
        if parsed is None:
            continue
        if parsed["name"] in found:
            raise DiscoveryError(f"duplicate agent {parsed['name']}")
        found[parsed["name"]] = parsed
    missing = [name for name in ROLE_ORDER if name not in found]
    if missing:
        raise DiscoveryError("missing agents: " + ", ".join(missing))
    ordered = [found[name] for name in ROLE_ORDER]
    for index, agent in enumerate(ordered, start=1):
        if agent["order"] != index:
            raise DiscoveryError(
                f"{agent['name']} order {agent['order']} is not {index}"
            )
    return ordered


def _outcome(
    role: str,
    verdict: str,
    reason: str,
    checked: list[str],
    skipped: list[str],
) -> dict:
    return {
        "role": role,
        "verdict": verdict,
        "reason": reason,
        "checked": list(checked),
        "skipped": list(skipped),
    }


def _missing(record: dict, fields: tuple[str, ...]) -> list[str]:
    return [field for field in fields if field not in record]


def _refuse_missing(role: str, missing: list[str], present: list[str]) -> dict:
    return _outcome(
        role,
        "refuse",
        "not in evidence: " + ", ".join(missing),
        present,
        missing,
    )


def _not_bool(record: dict, fields: tuple[str, ...]) -> list[str]:
    return [field for field in fields if not isinstance(record[field], bool)]


def _refuse_not_bool(
    role: str,
    untyped: list[str],
    present: list[str],
    absent: list[str] | None = None,
) -> dict:
    return _outcome(
        role,
        "refuse",
        "not a boolean, so not evidence: " + ", ".join(untyped),
        [field for field in present if field not in untyped],
        untyped + list(absent or []),
    )


def gate_drought(record: dict) -> dict:
    role = "gate-drought"
    required = ("pressure_requests_override",)
    observed = ("empty_queue", "deadline_pressure")
    missing = _missing(record, required)
    present = [field for field in required + observed if field in record]
    skipped = [field for field in observed if field not in record]
    if missing:
        return _refuse_missing(role, missing, present)
    untyped = _not_bool(record, tuple(present))
    if untyped:
        return _refuse_not_bool(role, untyped, present, skipped)
    if record["pressure_requests_override"] is not False:
        return _outcome(
            role,
            "refuse",
            "refusal belongs in the gate and not in the mood of an empty queue or a deadline",
            present,
            skipped,
        )
    return _outcome(
        role,
        "allow",
        "pressure was read and did not loosen the gate",
        present,
        skipped,
    )


def inscription(record: dict) -> dict:
    role = "inscription"
    fields = (
        "parses_cleanly",
        "signature_valid",
        "signer_verified",
        "signer_pinned",
        "self_attested",
    )
    missing = _missing(record, fields)
    present = [field for field in fields if field in record]
    if missing:
        return _refuse_missing(role, missing, present)
    untyped = _not_bool(record, fields)
    if untyped:
        return _refuse_not_bool(role, untyped, present)
    pinned = record["signer_pinned"] is True
    self_attested = record["self_attested"] is True
    structurally_valid = (
        record["parses_cleanly"] is True and record["signature_valid"] is True
    )
    signer_ok = record["signer_verified"] is True and pinned and not self_attested
    if not structurally_valid or not signer_ok:
        why = []
        if not pinned:
            why.append("unpinned")
        if self_attested:
            why.append("self-attested")
        if record["signer_verified"] is not True:
            why.append("signer not verified")
        if not structurally_valid:
            why.append("structure is not a credential")
        return _outcome(
            role,
            "refuse",
            "not authority to pay; a readable label is not a credential ("
            + ", ".join(why)
            + ")",
            present,
            [],
        )
    return _outcome(role, "allow", "signer verified and pinned", present, [])


def settlement_not_delivery(record: dict) -> dict:
    role = "settlement-not-delivery"
    fields = ("settlement_visible", "delivery_evidence")
    missing = _missing(record, fields)
    present = [field for field in fields if field in record]
    if missing:
        return _refuse_missing(role, missing, present)
    untyped = _not_bool(record, fields)
    if untyped:
        return _refuse_not_bool(role, untyped, present)
    if record["delivery_evidence"] is not True:
        if record["settlement_visible"] is True:
            reason = "settlement is not delivery; a visible transfer does not stand in for the thing it claims to have caused"
        else:
            reason = "no delivery evidence; payout needs delivery, settled or not"
        return _outcome(role, "refuse", reason, present, [])
    return _outcome(
        role,
        "allow",
        "delivery evidence was present and was not inferred from settlement",
        present,
        [],
    )


def familiar_face(record: dict) -> dict:
    role = "familiar-face"
    fields = ("known_name_vouches", "unknown_key", "unknown_key_verified")
    missing = _missing(record, fields)
    present = [field for field in fields if field in record]
    if missing:
        return _refuse_missing(role, missing, present)
    untyped = _not_bool(record, fields)
    if untyped:
        return _refuse_not_bool(role, untyped, present)
    if record["unknown_key"] is True and record["unknown_key_verified"] is not True:
        return _outcome(
            role,
            "refuse",
            "a known name does not vouch for an unknown party; verify the unknown key as if no one had spoken",
            present,
            [],
        )
    return _outcome(
        role,
        "allow",
        "reputation was not treated as transitive",
        present,
        [],
    )


def collapsed_time(record: dict) -> dict:
    role = "collapsed-time"
    fields = ("must_decide_now", "receipt_thin")
    missing = _missing(record, fields)
    present = [field for field in fields if field in record]
    if missing:
        return _refuse_missing(role, missing, present)
    untyped = _not_bool(record, fields)
    if untyped:
        return _refuse_not_bool(role, untyped, present)
    if record["must_decide_now"] is True:
        return _outcome(
            role,
            "hand_to_human",
            "when time collapses and the decision must happen now, fail closed and hand it to a human",
            present,
            [],
        )
    return _outcome(role, "allow", "the decision was not forced into a collapsed window", present, [])


def one_eyed_verifier(record: dict) -> dict:
    role = "one-eyed-verifier"
    fields = ("check_scope", "reported_as_full_verification")
    missing = _missing(record, fields)
    present = [field for field in fields if field in record]
    if missing:
        return _refuse_missing(role, missing, present)
    untyped = _not_bool(record, ("reported_as_full_verification",))
    if untyped:
        return _refuse_not_bool(role, untyped, present)
    scope = record["check_scope"]
    if scope != "full":
        return _outcome(
            role,
            "refuse",
            "not a full verification; a half-run check is not verified, and a schema pass is not an audit",
            present,
            [],
        )
    return _outcome(role, "allow", "the check scope was full", present, [])


def evidence_only(record: dict) -> dict:
    role = "evidence-only"
    fields = ("claim_wider_than_evidence", "quick_integration_called_traction")
    missing = _missing(record, fields)
    present = [field for field in fields if field in record]
    if missing:
        return _refuse_missing(role, missing, present)
    untyped = _not_bool(record, fields)
    if untyped:
        return _refuse_not_bool(role, untyped, present)
    if (
        record["claim_wider_than_evidence"] is True
        or record["quick_integration_called_traction"] is True
    ):
        return _outcome(
            role,
            "refuse",
            "say only what the evidence shows; a quick integration or an overstated claim is not traction",
            present,
            [],
        )
    return _outcome(role, "allow", "the claim stays inside the evidence", present, [])


ROLES = {
    "gate-drought": gate_drought,
    "inscription": inscription,
    "settlement-not-delivery": settlement_not_delivery,
    "familiar-face": familiar_face,
    "collapsed-time": collapsed_time,
    "one-eyed-verifier": one_eyed_verifier,
    "evidence-only": evidence_only,
}


def _stopped(verdict: str, role: str, reason: str, checked: list[dict], start: int) -> dict:
    skipped = [
        {"role": name, "reason": "not reached"} for name in ROLE_ORDER[start:]
    ]
    return {
        "verdict": verdict,
        "refusing_role": role,
        "refusals": [{"role": role, "verdict": verdict, "reason": reason}],
        "checked": checked,
        "skipped": skipped,
        "payout_authorized": False,
    }


def decide(record: dict) -> dict:
    """Apply the seven discovered roles in fixed order. Same record, same verdict."""
    if not isinstance(record, dict):
        return _stopped("refuse", "input", "decision record is not an object", [], 0)
    try:
        agents = discover_agents()
    except DiscoveryError as exc:
        return _stopped("refuse", "discovery", exc.reason, [], 0)
    if [agent["name"] for agent in agents] != list(ROLE_ORDER):
        return _stopped("refuse", "discovery", "discovered role order does not match the fold", [], 0)
    checked: list[dict] = []
    handoff: dict | None = None
    for index, name in enumerate(ROLE_ORDER):
        outcome = ROLES[name](record)
        if outcome["role"] != name or outcome["verdict"] not in ("allow", "refuse", "hand_to_human"):
            return _stopped("refuse", name, "role returned an unusable result", checked, index)
        checked.append(outcome)
        if outcome["verdict"] == "refuse":
            return _stopped("refuse", name, outcome["reason"], checked, index + 1)
        if outcome["verdict"] == "hand_to_human" and handoff is None:
            handoff = outcome
    if handoff is not None:
        return _stopped(
            "hand_to_human", handoff["role"], handoff["reason"], checked, len(ROLE_ORDER)
        )
    return {
        "verdict": "allow",
        "refusing_role": None,
        "refusals": [],
        "checked": checked,
        "skipped": [],
        "payout_authorized": True,
    }
