#!/usr/bin/env python3
"""TWZRD auto-pay MCP server (Python, Solana x402) — the VERIFIED shippable path.

Uses the official x402 SDK client (ExactSvmClientScheme + KeypairSigner +
x402_requests) — the exact wiring proven on mainnet 2026-06-26 ($0.001 settle,
HTTP 200, paid:true). This is the part the hand-rolled TS draft got wrong: only
the SDK produces a PaymentPayload the intel host accepts.

Free tools never pay. Paid tools auto-pay via x402 with spend caps + preflight.

ENV:
  TWZRD_WALLET_KEYPAIR     path to a Solana keypair json (default ~/.config/solana/id.json)
  TWZRD_RPC_URL            Solana RPC (required for signing)
  TWZRD_API_URL            default https://intel.twzrd.xyz
  TWZRD_MAX_USDC_PER_CALL  default 0.05
  TWZRD_MAX_USDC_TOTAL     default 1.00
  TWZRD_MCP_PAYMENTS_ENABLED  "1" to enable signing
"""
from __future__ import annotations

import asyncio
import json
import os

import requests
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

API_BASE = os.environ.get("TWZRD_API_URL", "https://intel.twzrd.xyz")
MAX_PER_CALL = float(os.environ.get("TWZRD_MAX_USDC_PER_CALL", "0.05"))
MAX_TOTAL = float(os.environ.get("TWZRD_MAX_USDC_TOTAL", "1.00"))
PAYMENTS_ENABLED = os.environ.get("TWZRD_MCP_PAYMENTS_ENABLED") == "1"

_paid_session: requests.Session | None = None
_spent = 0.0


def _build_paid_session() -> requests.Session:
    """The verified x402 client wiring (mainnet-proven)."""
    from solders.keypair import Keypair
    from x402.client import x402ClientSync
    from x402.mechanisms.svm.exact import register_exact_svm_client
    from x402.mechanisms.svm.signers import KeypairSigner
    from x402.http.clients.requests import x402_requests

    kp_path = os.environ.get("TWZRD_WALLET_KEYPAIR", os.path.expanduser("~/.config/solana/id.json"))
    rpc = os.environ.get("TWZRD_RPC_URL")
    if not rpc:
        raise RuntimeError("TWZRD_RPC_URL required for x402 signing")
    kp = Keypair.from_bytes(bytes(json.load(open(kp_path))))
    client = x402ClientSync()
    register_exact_svm_client(client, KeypairSigner(kp), rpc_url=rpc)
    return x402_requests(client)


def _paid_get(path: str) -> str:
    global _paid_session, _spent
    if not PAYMENTS_ENABLED:
        raise RuntimeError("Auto-pay disabled. Set TWZRD_MCP_PAYMENTS_ENABLED=1 to enable signing.")
    # Per-call cap is enforced by refusing endpoints we know exceed it; cumulative
    # cap is checked against MAX_TOTAL before the call. (Quick=$0.001, full=$0.05.)
    price = 0.05 if "/trust/" in path else 0.001
    if price > MAX_PER_CALL:
        raise RuntimeError(f"Refusing: ${price} exceeds per-call cap ${MAX_PER_CALL}")
    if _spent + price > MAX_TOTAL:
        raise RuntimeError(f"Refusing: would exceed session cap ${MAX_TOTAL} (spent ${_spent})")
    if _paid_session is None:
        _paid_session = _build_paid_session()
    r = _paid_session.get(f"{API_BASE}{path}", timeout=90)
    body = r.text
    # Only count spend when the server actually charged (it returns charged_amount_usdc).
    try:
        if json.loads(body).get("paid"):
            _spent += float(json.loads(body).get("charged_amount_usdc", price))
    except Exception:
        pass
    return body


def _free(method: str, path: str, payload: dict | None = None) -> str:
    if method == "POST":
        return requests.post(f"{API_BASE}{path}", json=payload, timeout=30).text
    return requests.get(f"{API_BASE}{path}", timeout=30).text


def _verify_receipt(wallet: str) -> str:
    """FREE offline verification of a wallet's cNFT Receipt. Reuses the audited
    twzrd-receipt-verifier (Ed25519 over the compact-JSON anchor vs the genesis
    authority 2ELSDx) — no payment, and no trust in TWZRD's API beyond fetching the
    public receipt bytes (the signature is what's checked)."""
    import verify_twzrd_receipt as V  # twzrd-receipt-verifier (PyPI dependency)

    url = f"https://twzrd.xyz/r/{wallet}.json"
    receipt = json.loads(requests.get(url, timeout=20).text)
    if not receipt.get("cnft_minted"):
        return json.dumps({"wallet": wallet, "valid": False,
                           "reason": "no cNFT Receipt minted for this wallet", "source": url})
    res = V.verify_cnft(receipt, V.DEFAULT_CNFT_PUBKEY, wallet)
    anchor = receipt.get("anchor") or {}
    return json.dumps({
        "wallet": wallet,
        "valid": bool(res.get("valid")),
        "signature_valid": res.get("signature_valid"),
        "tier_at_mint": anchor.get("tier_at_mint"),
        "score_at_mint": anchor.get("score_at_mint"),
        "verify_pubkey": V.DEFAULT_CNFT_PUBKEY,
        "errors": res.get("errors", []),
        "source": url,
    })


app = Server("twzrd-mcp-server")

TOOLS = [
    Tool(name="preflight", description="FREE pre-pay check: allow/warn/block + trust_score.", inputSchema={"type": "object", "properties": {"seller_wallet": {"type": "string"}, "price_usdc": {"type": "number"}}, "required": ["seller_wallet"]}),
    Tool(name="wallet_lookup", description="FREE: facilitators + counterparty breadth for a Solana wallet.", inputSchema={"type": "object", "properties": {"wallet": {"type": "string"}}, "required": ["wallet"]}),
    Tool(name="verify_receipt", description="FREE: independently verify a wallet's cNFT Receipt offline (Ed25519 vs the genesis authority 2ELSDx). No trust in any TWZRD server.", inputSchema={"type": "object", "properties": {"wallet": {"type": "string"}}, "required": ["wallet"]}),
    Tool(name="quick_trust", description="PAID $0.001 (auto-pay x402, Solana): quick tier+score for a wallet.", inputSchema={"type": "object", "properties": {"wallet": {"type": "string"}}, "required": ["wallet"]}),
    Tool(name="full_trust", description="PAID $0.05 (auto-pay x402, Solana): full trust intel + signed V6 receipt.", inputSchema={"type": "object", "properties": {"wallet": {"type": "string"}, "seller_wallet": {"type": "string"}}, "required": ["wallet"]}),
]


@app.list_tools()
async def list_tools() -> list[Tool]:
    return TOOLS


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    a = arguments or {}
    if name == "preflight":
        out = _free("POST", "/v1/intel/preflight", {"seller_wallet": a.get("seller_wallet"), "resource_name": "MCP", "price_usdc": a.get("price_usdc", 0.05)})
    elif name == "wallet_lookup":
        out = _free("GET", f"/v1/intel/get_facilitator_footprint?wallet={a['wallet']}")
    elif name == "verify_receipt":
        out = _verify_receipt(a["wallet"])
    elif name in ("quick_trust", "full_trust"):
        # No counterparty gate here: these pay TWZRD (a trusted provider) a fixed
        # micro-fee for intel ON a['wallet']. Gating the payment on the TARGET's risk
        # would withhold the very intel you're buying — you look up risky wallets ON
        # PURPOSE. The spend caps in _paid_get are the guard. Use the free `preflight`
        # tool to vet a SELLER you're about to pay elsewhere.
        path = f"/v1/intel/quick/{a['wallet']}" if name == "quick_trust" else f"/v1/intel/trust/{a['wallet']}" + (f"?seller_wallet={a['seller_wallet']}" if a.get("seller_wallet") else "")
        out = _paid_get(path)
    else:
        raise ValueError(f"Unknown tool: {name}")
    return [TextContent(type="text", text=out)]


async def _main() -> None:
    async with stdio_server() as (r, w):
        await app.run(r, w, app.create_initialization_options())


def main() -> None:
    """Console-script entry point (`twzrd-mcp`). Runs the stdio MCP server."""
    asyncio.run(_main())


if __name__ == "__main__":
    main()
