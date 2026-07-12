# twzrd-mcp-server / twzrd-mcp — pre-spend trust MCP for Solana x402 agents

<!-- mcp-name: xyz.twzrd/twzrd-mcp -->

Vet a counterparty **before** you pay over Solana x402. Free tools return
allow / warn / block for the seller you're about to pay; optional paid tools buy
a score or a signed V6 receipt — spend-capped and opt-in. **Prefer the
zero-install remote MCP; use this package only when you want local auto-pay for
paid intel.**

```json
// Recommended — 23 tools, no wallet, nothing to install
{ "mcpServers": { "twzrd": { "url": "https://intel.twzrd.xyz/mcp" } } }
```

```bash
# Local auto-pay client — 5 tools; wallet only if you enable paid calls
npx -y twzrd-mcp-server        # Node
pip install twzrd-mcp          # Python
```

- **npm** (Node): [`twzrd-mcp-server`](https://www.npmjs.com/package/twzrd-mcp-server)
- **PyPI** (Python): [`twzrd-mcp`](https://pypi.org/project/twzrd-mcp/)
- Trust API: <https://intel.twzrd.xyz> · repo: [twzrd-sol/twzrd-trust](https://github.com/twzrd-sol/twzrd-trust)

## Which surface do I want?

| Surface | Tools | Wallet | Use when |
|---------|-------|--------|----------|
| `https://intel.twzrd.xyz/mcp` (remote) | 23 | No | Default. Preflight, merchant cards, wash checks, watches, markets — all free. |
| `twzrd-mcp-server` / `twzrd-mcp` (this package) | 5 | Only for paid | You want `quick_trust` / `full_trust` auto-paid locally with caps. |

Remote is also on Smithery: `https://smithery.ai/servers/wzrd/twzrd-agent-intel`.

## The 5 local client tools

| Tool | Cost | What |
|------|------|------|
| `preflight` | free | allow / warn / block + trust score for a **seller you're about to pay** |
| `wallet_lookup` | free | facilitators + counterparty breadth for a wallet |
| `verify_receipt` | free | offline-verify a wallet's cNFT receipt (Ed25519 vs genesis authority `2ELSDxLkb7dYrN6EUG69tNtULAq4Fo7WPvXyrZPmuFif`) — trust no server |
| `quick_trust` | $0.001 | quick tier + score for any wallet |
| `full_trust` | $0.05 | full trust intel + signed V6 receipt |

> `quick_trust` / `full_trust` buy intel on **any** wallet (you look risky ones up
> on purpose) — they don't refuse a target. Use `preflight` to vet a wallet you're
> about to *pay elsewhere*.

## Happy path (seller-first)

1. **Free `preflight`** on the seller's receive wallet.
2. `block` → don't pay. Done, $0 spent.
3. `warn` → consider a $0.05 `full_trust` signed receipt before deciding.
4. `allow` + small spend → pay. Keep the receipt; scores decay, so re-check stale decisions.

## Install & config

Paid tools are **opt-in on both runtimes**: they sign only when you set
`TWZRD_MCP_PAYMENTS_ENABLED=1` **and** provide a wallet key. For free tools, omit
both — the server runs read-only and never signs. Spend is bounded by per-call and
session caps.

### Python — `pip install twzrd-mcp`

```json
{ "mcpServers": { "twzrd": {
  "command": "twzrd-mcp",
  "env": {
    "TWZRD_RPC_URL": "<your dedicated Solana RPC url>",
    "TWZRD_WALLET_KEYPAIR": "/path/to/solana-keypair.json",
    "TWZRD_MCP_PAYMENTS_ENABLED": "1",
    "TWZRD_MAX_USDC_PER_CALL": "0.05",
    "TWZRD_MAX_USDC_TOTAL": "1.00"
  }
}}}
```

### Node — `npx -y twzrd-mcp-server`

```json
{ "mcpServers": { "twzrd": {
  "command": "npx", "args": ["-y", "twzrd-mcp-server"],
  "env": {
    "TWZRD_RPC_URL": "<your dedicated Solana RPC url>",
    "TWZRD_WALLET_SECRET_KEY": "<base58 Solana secret>",
    "TWZRD_MCP_PAYMENTS_ENABLED": "1",
    "TWZRD_MAX_USDC_PER_CALL": "0.05",
    "TWZRD_MAX_USDC_TOTAL": "1.00"
  }
}}}
```

| Env var | Default | Meaning |
|---------|---------|---------|
| `TWZRD_MCP_PAYMENTS_ENABLED` | unset (off) | set `1` to arm paid tools — **required on both runtimes** |
| `TWZRD_WALLET_SECRET_KEY` (Node) / `TWZRD_WALLET_KEYPAIR` (Python) | — | signer for paid tools |
| `TWZRD_MAX_USDC_PER_CALL` | `0.05` | per-call spend cap |
| `TWZRD_MAX_USDC_TOTAL` | `1.00` | cumulative session spend cap |
| `TWZRD_RPC_URL` | **none — required for paid tools** | Solana RPC. Paid tools refuse to arm without it: the public RPC is rate-limited and loses x402 races (stale blockhash / sponsored feePayer between the 402 challenge and the signed retry), and a rejected settle can still move USDC. Free tools need no RPC. Set `TWZRD_ALLOW_PUBLIC_RPC=1` to accept that risk anyway. |

## Safety

- **Opt-in payments** — paid tools sign only with `TWZRD_MCP_PAYMENTS_ENABLED=1`; a wallet key alone never arms spending.
- **Spend caps** — per-call and session caps enforced in the payment selector *before* any signature.
- **Solana-only** — a non-`exact` / non-`solana:` challenge is refused, never mis-signed.
- **Single-shot retry** — at most one signed retry per tool call; a second 402 is surfaced, not silently re-paid.
- **Free tools never enter the payment path.**

## Verify receipts offline (trust no one)

`full_trust` returns a portable Ed25519-signed V6 receipt. Verify it without
trusting any TWZRD server — the issuer key is `twzrd-receipt-ed25519-v1`
(`9V6Pn19kiUA5Rn6JpQfNduanvGt2aXGwsarosNfa2Ldf`), pinned at
<https://intel.twzrd.xyz/.well-known/twzrd-receipt-pubkey>:

```bash
npx twzrd-receipt-verifier <receipt.json> --pubkey 9V6Pn19kiUA5Rn6JpQfNduanvGt2aXGwsarosNfa2Ldf
```

## Development

`npm run build && npm run demo` lists tools and runs a free preflight from source
(no spend by default). For the operator-authorized `$0.001` settle proof, set
`TWZRD_DEMO_PAID=quick`, provide a wallet key, and pin both caps to `0.001`
(see `examples/agent-drop-in.mjs`).

---

Links: [intel.twzrd.xyz](https://intel.twzrd.xyz) · [llms.txt](https://intel.twzrd.xyz/llms.txt) · [OpenAPI](https://intel.twzrd.xyz/openapi.json)

License: MIT
