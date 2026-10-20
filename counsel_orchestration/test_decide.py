"""Call the shipped counsel fold. Do not reimplement its rules."""

from __future__ import annotations

import importlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from counsel_orchestration import decide, discover_agents

# The package re-exports decide(), which shadows the submodule attribute.
FOLD = importlib.import_module("counsel_orchestration.decide")

RULES = (
    "refusal belongs in the gate and not in the mood of an empty queue or a deadline",
    "a readable label is not a credential, so a clean parse and a valid signature still require verifying the signer and who pinned that signer",
    "settlement is not delivery and a visible transfer does not stand in for the thing it claims to have caused",
    "a known name does not vouch for an unknown party, and reputation is not transitive",
    "when time collapses and the decision must happen now, fail closed and hand it to a human",
    'a half-run check is not "verified," and a schema pass is not an audit',
    "say only what the evidence shows, and do not treat a quick integration or an overstated claim as traction",
)


def allow_record() -> dict:
    return {
        "pressure_requests_override": False,
        "empty_queue": False,
        "deadline_pressure": False,
        "parses_cleanly": True,
        "signature_valid": True,
        "signer_verified": True,
        "signer_pinned": True,
        "self_attested": False,
        "settlement_visible": True,
        "delivery_evidence": True,
        "known_name_vouches": False,
        "unknown_key": False,
        "unknown_key_verified": False,
        "must_decide_now": False,
        "receipt_thin": False,
        "check_scope": "full",
        "reported_as_full_verification": True,
        "claim_wider_than_evidence": False,
        "quick_integration_called_traction": False,
    }


class DiscoverTest(unittest.TestCase):
    def test_two_loads_list_the_same_seven_rules(self) -> None:
        first = discover_agents()
        second = discover_agents()
        self.assertEqual([item["name"] for item in first], [item["name"] for item in second])
        self.assertEqual(
            [item["name"] for item in first],
            [
                "gate-drought",
                "inscription",
                "settlement-not-delivery",
                "familiar-face",
                "collapsed-time",
                "one-eyed-verifier",
                "evidence-only",
            ],
        )
        bodies = "\n".join(item["body"] for item in first)
        other = "\n".join(item["body"] for item in second)
        self.assertEqual(bodies, other)
        for rule in RULES:
            self.assertIn(rule, bodies)

    def test_unreadable_order_refuses_instead_of_raising(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for agent in discover_agents():
                source = Path(agent["path"])
                text = source.read_text(encoding="utf-8")
                if agent["name"] == "familiar-face":
                    text = text.replace("order: 4", "order: four")
                (root / source.name).write_text(text, encoding="utf-8")
            with mock.patch.object(FOLD, "agents_dir", return_value=root):
                result = decide(allow_record())
        self.assertEqual(result["verdict"], "refuse")
        self.assertEqual(result["refusing_role"], "discovery")
        self.assertFalse(result["payout_authorized"])


class DecideTest(unittest.TestCase):
    def test_clean_record_allows_twice_with_nothing_skipped(self) -> None:
        record = allow_record()
        first = decide(record)
        second = decide(record)
        self.assertEqual(first, second)
        self.assertEqual(first["verdict"], "allow")
        self.assertIsNone(first["refusing_role"])
        self.assertEqual(first["refusals"], [])
        self.assertEqual(first["skipped"], [])
        self.assertEqual(
            [item["role"] for item in first["checked"]],
            [item["name"] for item in discover_agents()],
        )
        self.assertTrue(first["payout_authorized"])
        self.assertTrue(all(item["verdict"] == "allow" for item in first["checked"]))

    def test_unpinned_or_self_attested_is_not_authority_to_pay(self) -> None:
        for patch in ({"signer_pinned": False}, {"self_attested": True}):
            record = allow_record()
            record.update(patch)
            first = decide(record)
            second = decide(record)
            self.assertEqual(first, second)
            self.assertEqual(first["verdict"], "refuse")
            self.assertEqual(first["refusing_role"], "inscription")
            self.assertIn("not authority to pay", first["refusals"][0]["reason"])
            self.assertFalse(first["payout_authorized"])
            self.assertIn("settlement-not-delivery", [item["role"] for item in first["skipped"]])

    def test_settlement_without_delivery_is_refused(self) -> None:
        record = allow_record()
        record["delivery_evidence"] = False
        first = decide(record)
        second = decide(record)
        self.assertEqual(first, second)
        self.assertEqual(first["verdict"], "refuse")
        self.assertEqual(first["refusing_role"], "settlement-not-delivery")
        self.assertIn("settlement is not delivery", first["refusals"][0]["reason"])
        self.assertFalse(first["payout_authorized"])
        self.assertEqual(
            [item["role"] for item in first["skipped"]],
            ["familiar-face", "collapsed-time", "one-eyed-verifier", "evidence-only"],
        )

    def test_known_name_does_not_vouch_for_an_unknown_key(self) -> None:
        record = allow_record()
        record["known_name_vouches"] = True
        record["unknown_key"] = True
        record["unknown_key_verified"] = False
        first = decide(record)
        second = decide(record)
        self.assertEqual(first, second)
        self.assertEqual(first["verdict"], "refuse")
        self.assertEqual(first["refusing_role"], "familiar-face")
        self.assertIn("as if no one had spoken", first["refusals"][0]["reason"])
        self.assertFalse(first["payout_authorized"])

    def test_verified_unknown_key_is_not_carried_by_the_name(self) -> None:
        record = allow_record()
        record["known_name_vouches"] = True
        record["unknown_key"] = True
        record["unknown_key_verified"] = True
        result = decide(record)
        self.assertEqual(result["verdict"], "allow")
        familiar = next(item for item in result["checked"] if item["role"] == "familiar-face")
        self.assertIn("known_name_vouches", familiar["checked"])
        self.assertEqual(familiar["verdict"], "allow")

    def test_urgent_thin_receipt_is_handed_to_a_human(self) -> None:
        record = allow_record()
        record["must_decide_now"] = True
        record["receipt_thin"] = True
        first = decide(record)
        second = decide(record)
        self.assertEqual(first, second)
        self.assertEqual(first["verdict"], "hand_to_human")
        self.assertNotEqual(first["verdict"], "allow")
        self.assertEqual(first["refusing_role"], "collapsed-time")
        self.assertFalse(first["payout_authorized"])
        self.assertEqual(
            [item["role"] for item in first["skipped"]],
            ["one-eyed-verifier", "evidence-only"],
        )

    def test_schema_only_or_partial_check_is_not_a_full_verification(self) -> None:
        for scope in ("schema_only", "partial"):
            record = allow_record()
            record["check_scope"] = scope
            record["reported_as_full_verification"] = True
            first = decide(record)
            second = decide(record)
            self.assertEqual(first, second)
            self.assertEqual(first["verdict"], "refuse")
            self.assertEqual(first["refusing_role"], "one-eyed-verifier")
            self.assertIn("not a full verification", first["refusals"][0]["reason"])
            self.assertFalse(first["payout_authorized"])
            self.assertEqual([item["role"] for item in first["skipped"]], ["evidence-only"])

    def test_claim_wider_than_evidence_is_refused(self) -> None:
        for patch in (
            {"claim_wider_than_evidence": True},
            {"quick_integration_called_traction": True},
        ):
            record = allow_record()
            record.update(patch)
            first = decide(record)
            second = decide(record)
            self.assertEqual(first, second)
            self.assertEqual(first["verdict"], "refuse")
            self.assertEqual(first["refusing_role"], "evidence-only")
            self.assertEqual(first["skipped"], [])
            self.assertFalse(first["payout_authorized"])

    def test_a_flag_that_is_not_a_boolean_is_not_evidence(self) -> None:
        # None means "not evaluated", never "clean"; 1 and "true" are not True.
        cases = {
            "gate-drought": ("pressure_requests_override",),
            "inscription": (
                "parses_cleanly",
                "signature_valid",
                "signer_verified",
                "signer_pinned",
                "self_attested",
            ),
            "settlement-not-delivery": ("settlement_visible", "delivery_evidence"),
            "familiar-face": ("known_name_vouches", "unknown_key", "unknown_key_verified"),
            "collapsed-time": ("must_decide_now", "receipt_thin"),
            "one-eyed-verifier": ("reported_as_full_verification",),
            "evidence-only": ("claim_wider_than_evidence", "quick_integration_called_traction"),
        }
        for role, fields in cases.items():
            for field in fields:
                for value in (None, 0, 1, "true", "false"):
                    record = allow_record()
                    record[field] = value
                    result = decide(record)
                    with self.subTest(field=field, value=value):
                        self.assertEqual(result["verdict"], "refuse")
                        self.assertEqual(result["refusing_role"], role)
                        self.assertFalse(result["payout_authorized"])

    def test_deadline_or_empty_queue_does_not_loosen_a_refusal(self) -> None:
        calm = allow_record()
        calm["signer_pinned"] = False
        pressured = dict(calm)
        pressured["empty_queue"] = True
        pressured["deadline_pressure"] = True
        pressured["pressure_requests_override"] = False
        override = dict(pressured)
        override["pressure_requests_override"] = True
        calm_result = decide(calm)
        pressed_result = decide(pressured)
        override_result = decide(override)
        self.assertEqual(decide(pressured), pressed_result)
        self.assertEqual(calm_result["verdict"], "refuse")
        self.assertEqual(pressed_result["verdict"], "refuse")
        self.assertEqual(calm_result["refusing_role"], "inscription")
        self.assertEqual(pressed_result["refusing_role"], "inscription")
        self.assertEqual(calm_result["refusals"], pressed_result["refusals"])
        self.assertFalse(pressed_result["payout_authorized"])
        self.assertEqual(override_result["verdict"], "refuse")
        self.assertEqual(override_result["refusing_role"], "gate-drought")
        self.assertNotEqual(override_result["verdict"], "allow")
        drought = override_result["checked"][0]
        self.assertIn("empty_queue", drought["checked"])
        self.assertIn("deadline_pressure", drought["checked"])


if __name__ == "__main__":
    unittest.main()
