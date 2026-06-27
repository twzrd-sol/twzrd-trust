# twzrd-mcp-server - auto-pay MCP for the TWZRD Trust API

<!-- mcp-name: xyz.twzrd/twzrd-mcp -->

> Payment mechanism is mainnet-verified via the official x402 SDK (Python path,
> $0.001 moved 2026-06-26 - see Status). As of v0.2.0 the bundled TypeScript path
> uses the official x402 JS SDK (`@x402/core` + `@x402/svm` + `@x402/fetch`) and
> is construct-verified against the live mainnet challenge; one real on-chain
> settle remains before npm publish.

Auto-pay MCP server for TWZRD's Trust API, matching the competitor GTM shape
(anchor-x402, Br0ski777, BitBooth all ship one). An agent adds one `mcpServers`
entry; paid tool calls auto-handle the x402 challenge. Free tools never pay.

## Why this is a corrected rebuild
A first draft signed **EIP-3009 on Base (EVM/viem)**. TWZRD settles x402 on
**Solana** (`scheme:"exact"`, USDC, sponsored `feePayer`) — the EVM scheme never
matches the challenge, so that draft could not pay TWZRD at all (it would `tsc`-pass
yet fail every real call). This version is Solana-native and **refuses** any
non-Solana challenge instead of mis-signing.

## Safety guardrails (enforced before any signature)
- Per-call cap `TWZRD_MAX_USDC_PER_CALL` (default 0.05)
- Cumulative session cap `TWZRD_MAX_USDC_TOTAL` (default 1.00)
- Free discovery tools never enter the payment path
- No cross-chain fallback — a non-`exact`/non-`solana:` challenge is rejected
- Paid calls run the free preflight first; `decision=block` aborts the pay

## Status — payment path VERIFIED on mainnet 2026-06-26

Two authorized settles from dev wallet `2pHjZLqs…`:

1. **Hand-rolled `X-Payment` (this MCP's original approach): FAILED** — HTTP 402,
   no USDC moved. The intel host validates via the official x402 lib's
   `PaymentPayload`, so a hand-built header is rejected. (Green `tsc` ≠ settles —
   fail-closed default was correct.)
2. **Official x402 SDK: SUCCEEDED** — `GET /v1/intel/quick/CqtQPaAuQ5UR…` →
   **HTTP 200, `"paid":true,"charged_amount_usdc":0.001`**, tier Silver score 53.6.
   USDC balance moved `0.057236 → 0.056236` (exactly $0.001). A second call against
   a no-data pubkey returned `422 charged:false` — the server's no-charge-on-empty
   guard works.

**Conclusion: auto-pay works ONLY via the official x402 SDK, not a hand-rolled
header.** Proven client wiring (Python):

```python
from x402.client import x402ClientSync
from x402.mechanisms.svm.signers import KeypairSigner
from x402.mechanisms.svm.exact import register_exact_svm_client
from x402.http.clients.requests import x402_requests
client = x402ClientSync()
register_exact_svm_client(client, KeypairSigner(keypair), rpc_url=RPC)
session = x402_requests(client)
session.get("https://intel.twzrd.xyz/v1/intel/quick/<wallet>")  # auto-pays $0.001
```

### TypeScript path — integrated (v0.2.0)
The hand-rolled `payAndRetry` is replaced with the official x402 JS SDK
(`@x402/core` client + `@x402/svm` ExactSvmScheme + `@x402/fetch`
`wrapFetchWithPayment`). `@x402/svm` reads the challenge `extra.feePayer` and builds
the partially-signed sponsored transfer (verified no-spend against the live mainnet
challenge: 496-byte tx, 2 signature slots), and the SDK encodes the `X-PAYMENT`
header the server validates. Spend caps + preflight gate + free/paid split are
preserved — caps are enforced in the payment selector before any signature.
**Remaining:** one real $0.001 on-chain settle to confirm end-to-end, then npm
publish + MCP-registry listing.

## Install & Config

### Python (recommended — the mainnet-proven path)
```bash
pip install twzrd-mcp
```
MCP client config (`mcpServers`):
```json
{ "mcpServers": { "twzrd": {
  "command": "twzrd-mcp",
  "env": {
    "TWZRD_RPC_URL": "<your Solana RPC url>",
    "TWZRD_WALLET_KEYPAIR": "/path/to/solana-keypair.json",
    "TWZRD_MCP_PAYMENTS_ENABLED": "1",
    "TWZRD_MAX_USDC_PER_CALL": "0.05",
    "TWZRD_MAX_USDC_TOTAL": "1.00"
  }
}}}
```
The **free** tools (`preflight`, `wallet_lookup`) need no wallet and no flags — leave
`TWZRD_MCP_PAYMENTS_ENABLED` unset and they work read-only. Only the paid tools need
the keypair + `TWZRD_MCP_PAYMENTS_ENABLED=1`.

### Node (`npx twzrd-mcp-server`) — v0.2.0, x402 JS SDK
```json
{ "mcpServers": { "twzrd": {
  "command": "npx", "args": ["-y", "twzrd-mcp-server"],
  "env": {
    "TWZRD_WALLET_SECRET_KEY": "<base58 Solana secret>",
    "TWZRD_RPC_URL": "<your Solana RPC url>",
    "TWZRD_MAX_USDC_PER_CALL": "0.05",
    "TWZRD_MAX_USDC_TOTAL": "1.00"
  }
}}}
```
Auto-pay is enabled whenever `TWZRD_WALLET_SECRET_KEY` is present (set
`TWZRD_MCP_PAYMENTS_ENABLED=0` to force paid tools off). Free tools need no wallet.
Construct-verified against the live mainnet challenge; pending one real settle +
npm publish (until published, `npx twzrd-mcp-server` is not yet resolvable — see
the Python package above for a path that is live on PyPI today).

## Tools
- `preflight` (free) — allow/warn/block + trust_score before you pay a **seller** you're about to transact with
- `wallet_lookup` (free) — facilitators + counterparty breadth for a Solana wallet
- `verify_receipt` (free) — independently verify a wallet's cNFT Receipt offline (Ed25519 vs the genesis authority `2ELSDx`); no trust in any TWZRD server
- `quick_trust` ($0.001, auto-pay) — quick tier + score for any wallet
- `full_trust` ($0.05, auto-pay) — full trust intel + signed V6 receipt

> Note: `quick_trust`/`full_trust` pay TWZRD a fixed micro-fee for intel on **any** wallet — they do **not** refuse "risky" targets (you look those up on purpose). Use `preflight` to vet a counterparty you're about to *pay elsewhere*.
