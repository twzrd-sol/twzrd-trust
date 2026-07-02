# twzrd-mcp-server / twzrd-mcp — auto-pay MCP for the TWZRD Trust API

<!-- mcp-name: xyz.twzrd/twzrd-mcp -->

Check — and optionally auto-pay for — trust intel on any Solana wallet or x402
seller, straight from your agent. Add one `mcpServers` entry: **free** tools vet a
counterparty before you pay; **paid** tools buy fresh trust intel, spend-capped and
opt-in. Solana-native x402 via the official `@x402` SDK — it refuses any non-Solana
challenge instead of mis-signing.

- **npm** (Node): [`twzrd-mcp-server`](https://www.npmjs.com/package/twzrd-mcp-server)
- **PyPI** (Python): [`twzrd-mcp`](https://pypi.org/project/twzrd-mcp/)
- Trust API: <https://intel.twzrd.xyz> · repo: [twzrd-sol/twzrd-trust](https://github.com/twzrd-sol/twzrd-trust)

## Tools

| Tool | Cost | What |
|------|------|------|
| `preflight` | free | allow / warn / block + trust score for a **seller you're about to pay** |
| `wallet_lookup` | free | facilitators + counterparty breadth for a wallet |
| `verify_receipt` | free | offline-verify a wallet's cNFT receipt (Ed25519 vs genesis authority `2ELSDx`) — trust no server |
| `quick_trust` | $0.001 | quick tier + score for any wallet |
| `full_trust` | $0.05 | full trust intel + signed V6 receipt |

> These five are the **auto-pay client** tools. The full **18-tool** read-only
> surface (market data, wash checks, leaderboards, batch scoring) is the live MCP
> server at `https://intel.twzrd.xyz/mcp` — free, no auth, connect any MCP client.
>
> `quick_trust` / `full_trust` buy intel on **any** wallet (you look risky ones up
> on purpose) — they don't refuse a target. Use `preflight` to vet a wallet you're
> about to *pay elsewhere*.

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
    "TWZRD_RPC_URL": "<your Solana RPC url>",
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
    "TWZRD_RPC_URL": "<your Solana RPC url>",
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
| `TWZRD_RPC_URL` | mainnet-beta | Solana RPC endpoint |

## Safety

- **Opt-in payments** — paid tools sign only with `TWZRD_MCP_PAYMENTS_ENABLED=1`; a wallet key alone never arms spending.
- **Spend caps** — per-call and session caps enforced in the payment selector *before* any signature.
- **Solana-only** — a non-`exact` / non-`solana:` challenge is refused, never mis-signed.
- **Single-shot retry** — at most one signed retry per tool call; a second 402 is surfaced, not silently re-paid.
- **Free tools never enter the payment path.**

## Verify receipts offline (trust no one)

`full_trust` returns a portable Ed25519-signed v6 receipt. Verify it without
trusting any TWZRD server:

```bash
npx twzrd-receipt-verifier <receipt.json> --pubkey <published key>
```

## Demo

```bash
npm run build && npm run demo   # lists tools + runs a free preflight, no spend by default
```

To run the operator-authorized `$0.001` settle proof, set `TWZRD_DEMO_PAID=quick`,
provide a wallet key, and pin both caps to `0.001` (see `examples/agent-drop-in.mjs`).

---

Links: [intel.twzrd.xyz](https://intel.twzrd.xyz) · [llms.txt](https://intel.twzrd.xyz/llms.txt) · [OpenAPI](https://intel.twzrd.xyz/openapi.json)

License: MIT
