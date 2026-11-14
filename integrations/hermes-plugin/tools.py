"""Tool handlers. Standard library only; no network or subprocess at import time.

Every handler takes the tool arguments as one dict and returns a JSON string.
A failed lookup returns ok=false so a buyer policy can fail closed.
"""

import json
import re
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .schemas import ISSUER_PUBKEY

BASE_URL = "https://intel.twzrd.xyz"
VERIFIER_PACKAGE = "twzrd-receipt-verifier@1.4.4"
USER_AGENT = "twzrd-hermes-plugin/0.1.0"

_MAX_BODY = 1_000_000
_BASE58_KEY = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
_WALLET = re.compile(r"^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$")


def _fail(error: str, **extra) -> str:
    return json.dumps({"ok": False, "status": 0, "error": error, **extra})


def _http_json(url: str, payload: dict | None = None, timeout: float = 8.0) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        url, data=data, headers=headers, method="POST" if data is not None else "GET"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(_MAX_BODY).decode("utf-8")
            return {"ok": True, "status": resp.status, "data": json.loads(body)}
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read(_MAX_BODY).decode("utf-8", errors="replace")
        finally:
            exc.close()
        return {"ok": False, "status": exc.code, "error": body[:4000]}
    except Exception as exc:
        return {"ok": False, "status": 0, "error": f"{type(exc).__name__}: {exc}"}


def _wallet(args) -> str | None:
    raw = args.get("pay_to") if isinstance(args, dict) else None
    wallet = raw.strip() if isinstance(raw, str) else ""
    return wallet if _WALLET.match(wallet) else None


_BAD_WALLET = (
    "pay_to must be a Solana base58 address or a Base 0x address taken from the "
    "402 accepts[].payTo"
)


def handle_preflight(args: dict, **kwargs) -> str:
    wallet = _wallet(args)
    if wallet is None:
        return _fail(_BAD_WALLET)
    body: dict = {"seller_wallet": wallet}
    resource_url = args.get("resource_url")
    if isinstance(resource_url, str) and resource_url.strip():
        body["resource_url"] = resource_url.strip()
    price = args.get("price_usdc")
    if isinstance(price, (int, float)) and not isinstance(price, bool) and price >= 0:
        body["price_usdc"] = float(price)
    return json.dumps(_http_json(f"{BASE_URL}/v1/intel/preflight", payload=body))


def handle_merchant_card(args: dict, **kwargs) -> str:
    wallet = _wallet(args)
    if wallet is None:
        return _fail(_BAD_WALLET)
    encoded = urllib.parse.quote(wallet, safe="")
    return json.dumps(_http_json(f"{BASE_URL}/v1/intel/merchant_card/{encoded}"))


def handle_verify_receipt(args: dict, **kwargs) -> str:
    raw_path = args.get("receipt_path") if isinstance(args, dict) else None
    if not isinstance(raw_path, str) or not raw_path.strip():
        return _fail("receipt_path is required", valid=False)
    path = Path(raw_path.strip()).expanduser().resolve()
    if not path.is_file():
        return _fail(f"Receipt file not found: {path}", valid=False)
    pubkey = args.get("pubkey") or ISSUER_PUBKEY
    if not isinstance(pubkey, str) or not _BASE58_KEY.match(pubkey):
        return _fail("pubkey must be a base58 Ed25519 public key", valid=False)
    npx = shutil.which("npx")
    if npx is None:
        return _fail("npx (Node.js 16+) is required to run the pinned verifier", valid=False)
    cmd = [npx, "--yes", VERIFIER_PACKAGE, str(path), "--pubkey", pubkey]
    max_age = args.get("max_age_seconds")
    if isinstance(max_age, int) and not isinstance(max_age, bool) and max_age > 0:
        cmd += ["--max-age", str(max_age)]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=90, check=False,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return _fail("verifier timed out after 90 s", valid=False)
    except OSError as exc:
        return _fail(f"verifier could not start: {exc}", valid=False)
    valid = proc.returncode == 0
    return json.dumps(
        {
            "ok": valid,
            "valid": valid,
            "exit_code": proc.returncode,
            "stdout": proc.stdout.strip()[-4000:],
            "stderr": proc.stderr.strip()[-2000:],
        }
    )
