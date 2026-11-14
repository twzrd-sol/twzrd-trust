"""Hermes plugin: TWZRD Intel pre-spend seller screening and receipt verification."""

from pathlib import Path

from .schemas import SCHEMAS
from .tools import handle_merchant_card, handle_preflight, handle_verify_receipt

TOOLSET = "twzrd-intel"

_HANDLERS = {
    "twzrd_preflight": handle_preflight,
    "twzrd_merchant_card": handle_merchant_card,
    "twzrd_verify_receipt": handle_verify_receipt,
}


def register(ctx) -> None:
    for name, handler in _HANDLERS.items():
        spec = SCHEMAS[name]
        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema={
                "name": name,
                "description": spec["description"],
                "parameters": spec["parameters"],
            },
            handler=handler,
            description=spec["description"],
        )
    ctx.register_skill(
        "twzrd-intel",
        Path(__file__).parent / "skills" / "twzrd-intel" / "SKILL.md",
    )
