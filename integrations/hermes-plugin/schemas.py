"""JSON schemas the model sees. Keep in step with the handlers in tools.py."""

ISSUER_PUBKEY = "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS"

SCHEMAS = {
    "twzrd_preflight": {
        "description": (
            "Free pre-spend seller screening via TWZRD Intel. Call it with the payTo "
            "address of the x402 challenge you are about to sign. data.readiness_card "
            "carries an advisory decision (allow, warn or block) and "
            "maximum_recommended_spend_usdc. ok=false means the seller was not "
            "screened: do not pay."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pay_to": {
                    "type": "string",
                    "description": (
                        "Receiving address from the 402 accepts[].payTo: a Solana "
                        "base58 address or a Base 0x address. Never a placeholder."
                    ),
                },
                "resource_url": {
                    "type": "string",
                    "description": "Optional URL of the x402 resource being purchased.",
                },
                "price_usdc": {
                    "type": "number",
                    "description": "Optional quoted price in USDC, used to size the cap.",
                },
            },
            "required": ["pay_to"],
        },
    },
    "twzrd_merchant_card": {
        "description": (
            "Fetch the free TWZRD Intel merchant card for a receiving address: observed "
            "x402 settlement history, wash_flagged and decision (refuse, "
            "insufficient_evidence or no_negative_signal). wash_flagged=true means "
            "refuse; null means never evaluated, not clean."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pay_to": {
                    "type": "string",
                    "description": "Receiving seller address (Solana base58 or Base 0x).",
                }
            },
            "required": ["pay_to"],
        },
    },
    "twzrd_verify_receipt": {
        "description": (
            "Verify a saved TWZRD signed receipt JSON file (V7; V5 and V6 still verify) "
            "against a pinned Ed25519 issuer key using the pinned twzrd-receipt-verifier "
            "CLI. The check makes no network or RPC call; the first run downloads the "
            "pinned verifier from npm. Requires Node.js 16+ with npx."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "receipt_path": {
                    "type": "string",
                    "description": "Local filesystem path to the receipt JSON file.",
                },
                "pubkey": {
                    "type": "string",
                    "default": ISSUER_PUBKEY,
                    "description": "Base58 Ed25519 issuer public key to trust.",
                },
                "max_age_seconds": {
                    "type": "integer",
                    "description": (
                        "Optional staleness policy: reject a receipt whose signed "
                        "timestamp is older than this many seconds."
                    ),
                },
            },
            "required": ["receipt_path"],
        },
    },
}
