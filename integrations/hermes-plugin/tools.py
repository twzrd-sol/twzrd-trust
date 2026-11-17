"""Tool handlers. Standard library only; no network or subprocess at import time.

Every handler takes the tool arguments as one dict and returns a JSON string.
A failed lookup returns ok=false so a buyer policy can fail closed.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .schemas import ISSUER_PUBKEY

BASE_URL = "https://intel.twzrd.xyz"
VERIFIER_PACKAGE = "twzrd-receipt-verifier@1.4.4"
USER_AGENT = "twzrd-hermes-plugin/0.2.0"

_MAX_BODY = 1_000_000

# The verifier and every dependency are installed from verifier/package-lock.json, so the
# code that runs is fixed by integrity hash and cannot change under the version pin.
_VERIFIER_DIR = Path(__file__).parent / "verifier"
_VERIFIER_SCRIPT = ("node_modules", "twzrd-receipt-verifier", "verify_twzrd_receipt.js")
_INSTALL_TIMEOUT = 120
_VERIFY_TIMEOUT = 30

# The only variables the npm and node child processes receive. Nothing else in the host
# environment (provider API keys, tokens) is passed down.
_CHILD_ENV = ("PATH", "HOME")
_CHILD_ENV_NPM = (
    "NPM_CONFIG_CACHE",
    "NPM_CONFIG_REGISTRY",
    "NPM_CONFIG_USERCONFIG",
    "NPM_CONFIG_GLOBALCONFIG",
)
# Node.js and npm do not start on Windows without these.
_CHILD_ENV_WINDOWS = (
    "SYSTEMROOT", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
)
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


class _VerifierError(Exception):
    pass


def _child_env() -> dict:
    allowed = set(_CHILD_ENV) | set(_CHILD_ENV_NPM)
    if os.name == "nt":
        allowed |= set(_CHILD_ENV_WINDOWS)
    return {k: v for k, v in os.environ.items() if k.upper() in allowed}


def _cache_root() -> Path:
    return Path.home() / ".cache" / "twzrd-hermes-plugin"


def _ensure_verifier(npm: str, env: dict) -> Path:
    """Return the installed verifier script, installing it from the lockfile on first use."""
    lock = (_VERIFIER_DIR / "package-lock.json").read_bytes()
    root = _cache_root() / f"verifier-{hashlib.sha256(lock).hexdigest()[:16]}"
    script = root.joinpath(*_VERIFIER_SCRIPT)
    if script.is_file():
        return script
    root.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="stage-", dir=root.parent))
    try:
        for name in ("package.json", "package-lock.json"):
            shutil.copyfile(_VERIFIER_DIR / name, stage / name)
        try:
            proc = subprocess.run(
                [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                cwd=stage, env=env, capture_output=True, text=True,
                timeout=_INSTALL_TIMEOUT, check=False, stdin=subprocess.DEVNULL,
            )
        except subprocess.TimeoutExpired:
            raise _VerifierError(f"verifier install timed out after {_INSTALL_TIMEOUT} s")
        if proc.returncode != 0:
            raise _VerifierError(
                f"verifier install failed (npm ci exit {proc.returncode}): "
                f"{proc.stderr.strip()[-1000:]}"
            )
        try:
            os.replace(stage, root)
        except OSError:
            # Another process finished the same install first.
            if not script.is_file():
                raise
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    if not script.is_file():
        raise _VerifierError("verifier install did not produce the verifier script")
    return script


def handle_verify_receipt(args: dict, **kwargs) -> str:
    raw_path = args.get("receipt_path") if isinstance(args, dict) else None
    if not isinstance(raw_path, str) or not raw_path.strip():
        return _fail("receipt_path is required", valid=False)
    # The trusted key is never a tool argument: a caller-chosen key would report
    # valid=true for a receipt anyone signed.
    if "pubkey" in args:
        return _fail(
            "pubkey is not an argument: receipts are verified against the pinned "
            f"issuer key {ISSUER_PUBKEY}",
            valid=False,
            issuer_pubkey=ISSUER_PUBKEY,
        )
    path = Path(raw_path.strip()).expanduser().resolve()
    if not path.is_file():
        return _fail(f"Receipt file not found: {path}", valid=False)
    node, npm = shutil.which("node"), shutil.which("npm")
    if node is None or npm is None:
        return _fail("Node.js 16+ with npm is required to run the pinned verifier", valid=False)
    env = _child_env()
    try:
        script = _ensure_verifier(npm, env)
    except (_VerifierError, OSError) as exc:
        return _fail(f"{exc}", valid=False)
    cmd = [node, str(script), str(path), "--pubkey", ISSUER_PUBKEY]
    max_age = args.get("max_age_seconds")
    if isinstance(max_age, int) and not isinstance(max_age, bool) and max_age > 0:
        cmd += ["--max-age", str(max_age)]
    try:
        proc = subprocess.run(
            cmd, env=env, capture_output=True, text=True, timeout=_VERIFY_TIMEOUT,
            check=False, stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return _fail(f"verifier timed out after {_VERIFY_TIMEOUT} s", valid=False)
    except OSError as exc:
        return _fail(f"verifier could not start: {exc}", valid=False)
    valid = proc.returncode == 0
    return json.dumps(
        {
            "ok": valid,
            "valid": valid,
            "issuer_pubkey": ISSUER_PUBKEY,
            "verifier": VERIFIER_PACKAGE,
            "exit_code": proc.returncode,
            "stdout": proc.stdout.strip()[-4000:],
            "stderr": proc.stderr.strip()[-2000:],
        }
    )
