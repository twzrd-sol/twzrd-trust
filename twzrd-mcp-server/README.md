# twzrd-mcp-server / twzrd-mcp — pre-spend seller reputation for Solana x402

<!-- mcp-name: xyz.twzrd/twzrd-mcp -->

Check a seller wallet and requested resource **before** you pay over Solana x402.
Free tools return allow / warn / block. Paid clearance is **$0.001**
`quick_trust` / `twzrd.payment_decision.v1`. Optional `$0.05` `full_trust` is
Path A intel, not the primary SKU. TWZRD scores observed wallet and payment
behavior. It does not prove a person, company, or autonomous agent identity.

**Prefer the zero-install hosted Agent Intelligence MCP. Use this package only
when you want local auto-pay for paid intel.**

```json
// Recommended — full hosted tool set, no wallet, nothing to install
{ "mcpServers": { "twzrd": { "url": "https://intel.twzrd.xyz/mcp" } } }
```

```bash
# Local auto-pay client — 6 tools; wallet only if you enable paid calls
npx -y twzrd-mcp-server        # Node
pip install twzrd-mcp          # Python
```

- **npm** (Node): [`twzrd-mcp-server`](https://www.npmjs.com/package/twzrd-mcp-server)
- **PyPI** (Python): [`twzrd-mcp`](https://pypi.org/project/twzrd-mcp/)
- Agent Intelligence: <https://intel.twzrd.xyz> · repo: [twzrd-sol/twzrd-trust](https://github.com/twzrd-sol/twzrd-trust/tree/main/twzrd-mcp-server)

## Which surface do I want?

| Surface | Tool set | Wallet | Use when |
|---------|-------|--------|----------|
| `https://intel.twzrd.xyz/mcp` (hosted) | Full hosted set (live `tools/list`) | No | Default. Seller preflight, resource evaluation, reputation, receipts, watches, product-listing checks (`check_listing`), and observed-market research. |
| `twzrd-mcp-server` / `twzrd-mcp` (this local package) | 6 local tools | Only for paid | You want `quick_trust` / `full_trust` auto-paid locally with caps. |

Start with hosted `twzrd_demo_gate` for a zero-setup, zero-spend transcript of
the block path: a recorded example, not a live run. The hosted MCP is also [listed on Smithery](https://smithery.ai/servers/wzrd/twzrd-agent-intel).

## The 6 local client tools

| Tool | Cost | What |
|------|------|------|
| `preflight` | free | allow / warn / block + trust score for a **seller you're about to pay** |
| `merchant_card` | free | seller graph card — `wash_flagged: true` → **don't pay** (locked sequence step 2) |
| `wallet_lookup` | free | facilitators + counterparty breadth for a wallet |
| `verify_receipt` | free | offline-verify a wallet's cNFT receipt (Ed25519 vs genesis authority `2ELSDxLkb7dYrN6EUG69tNtULAq4Fo7WPvXyrZPmuFif`) — trust no server |
| `quick_trust` | **$0.001** | Clearance SKU: `twzrd.payment_decision.v1` / quick tier + score |
| `full_trust` | $0.05 | Optional Path A intel + signed V7 receipt — not the primary SKU |

> `quick_trust` / `full_trust` buy intel on **any** wallet (you look risky ones up
> on purpose) — they don't refuse a target. Use `preflight` to vet a wallet you're
> about to *pay elsewhere*.

## Happy path (seller-first)

1. **Free `preflight`** on the seller's receive wallet.
2. `block` → don't pay. Done, $0 spent.
3. **Free `merchant_card`** on the same wallet — `wash_flagged: true` → don't pay.
4. `warn` → **$0.001** `quick_trust` / `payment_decision.v1` clearance. Optional `$0.05` `full_trust` is Path A intel, not the primary SKU.
5. `allow` + clean card + small spend → pay. Keep the receipt; scores decay, so re-check stale decisions.

## Install & config

Paid tools are **opt-in on both runtimes**: they sign only when you set
`TWZRD_MCP_PAYMENTS_ENABLED=1` **and** provide a wallet key. For free tools, omit
both — the server runs read-only and never signs. Spend is bounded by a per-call cap
and a cumulative cap (Node: over any rolling hour, kept on disk; Python: per session).

Before any Solana signature the Node server pays through `twzrd-x402-gate@0.28.1`
`createBuyerFetch`: a recipient allowlist, a USDC-only price cap, a durable hourly
reservation and the gate's pinned fail-closed preflight. Its own `merchant_card`
check runs first, on the option the x402 client selected (the Python `twzrd-mcp`
client does the same check on the 402 `payTo`). It continues only on
`wash_flagged === false`. `wash_flagged: true` refuses (`twzrd_wash_flagged`). A seller
intel has not evaluated (`wash_flagged` null or absent, no card) refuses
(`twzrd_wash_unknown`): "not evaluated" is never read as clean. If intel cannot answer
(timeout, 5xx/429, unreadable body), the payment fails closed: an outage is never
read as clean either. That is the paying-client brake, not a Path A shop.

`twzrd-mcp-server@0.6.7` pins gate 0.28.1 exactly; 0.6.6 pins 0.27.0 (GHSA-6cqg-vwmj-qw2v), 0.6.5 and 0.6.4 pin 0.26.0, and 0.6.3 and earlier pin older gates.
An existing installation keeps its pinned gate until it upgrades.

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
| `TWZRD_MAX_USDC_TOTAL` | `1.00` | cumulative spend cap. **Node:** over any rolling hour, kept in the gate's crash-safe spend ledger on disk, so a restart does not reset it, and a payment whose outcome is unknown after signing stays counted. **Python:** per process session. |
| `TWZRD_ALLOWED_RECIPIENTS` (Node) | TWZRD intel's payTo `GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs` | comma-separated Solana payTo allowlist; any other recipient is refused before signing. An entry that is not a Solana address disarms paid tools. |
| `TWZRD_MCP_SPEND_LEDGER_FILE` (Node) | `~/.twzrd/mcp/spend-v2.jsonl` | spend ledger. Processes that share the file share the hourly cap (holds are written under a cross-process lock). |
| `TWZRD_MCP_DECISION_FILE` (Node) | `~/.twzrd/mcp/decisions.jsonl` | local allow/block decision log, append-only and never sent anywhere. Every server process appends to this one file (a stdio server is a new process per client session); it rotates at 64 MiB. Set it to give a server its own log. |
| `TWZRD_INTEL_BASE` (Node) | `https://intel.twzrd.xyz` | intel for the pre-sign preflight and `merchant_card` lookups. |
| `TWZRD_RPC_URL` | **none — required for paid tools** | Solana RPC. Paid tools refuse to arm without it: the public RPC is rate-limited and loses x402 races (stale blockhash / sponsored feePayer between the 402 challenge and the signed retry), and a rejected settle can still move USDC. Free tools need no RPC. The Solana Foundation public endpoints (`api.mainnet-beta`, `api.devnet` and `api.testnet` `.solana.com`, trailing dots ignored) and any URL with a `/public` path segment are refused, by the Node server and by the Python client; other shared public RPCs are not detected, so choose a dedicated one. `TWZRD_ALLOW_PUBLIC_RPC` no longer enables a refused URL. The Python client also refuses hosts it cannot read exactly as the Node parser does: IDN hosts (Unicode or `xn--`), IPv4 not written as a dotted quad (such as `127.1`), and hosts with unusual characters; give it an ASCII hostname. |

## Safety

- **Opt-in payments** — paid tools sign only with `TWZRD_MCP_PAYMENTS_ENABLED=1`; a wallet key alone never arms spending.
- **Spend caps** — per-call and cumulative caps enforced *before* any signature. Caps use the mint's **true** decimals, never merchant-declared `extra.decimals`. A mismatched declaration is refused. A malformed cap env (e.g. `"$0.05"`) falls back to the default; it never becomes NaN and disables the cap. On Node the cumulative cap lives in the on-disk spend ledger (see `TWZRD_MAX_USDC_TOTAL`), not in process memory.
- **Known-asset only** — the Node server pays USDC only. The Python client pays known USD-pegged stablecoins (USDC/USDT). Unknown SPL mints are refused by both.
- **Identifiable, allowlisted recipient** — a challenge with no `payTo` is refused. On Node a `payTo` outside `TWZRD_ALLOWED_RECIPIENTS` is refused by the selector and again by the gate.
- **Unevaluated sellers refused** — on both runtimes a seller with no boolean `wash_flagged` answer is refused (`twzrd_wash_unknown`). On Node the gate also refuses a preflight that did not evaluate the seller (`twzrd_unevaluated_subject_*`).
- **Outbound guard (Node)** — every request is `https` to a host that resolves only to public addresses (private, loopback, link-local, CGNAT and cloud-metadata ranges are refused), with `redirect: "error"`. A seller cannot redirect a paid call or probe to another host. A residual remains: the name is resolved once for the check and again when fetch connects.
- **Solana-only** — a non-`exact` / non-`solana:` challenge is refused, never mis-signed.
- **Single-shot retry** — at most one payment per tool call; a second 402 is surfaced, not silently re-paid.
- **One option, checked and signed** — on Node the wash check and the gate run as before-payment hooks on the option the x402 client actually selected, so the `payTo` that is checked is the `payTo` that is signed. The payment header that leaves must name that approved option (`payTo`, `amount`, `asset`, `network`, `scheme`) or it is refused.
- **Free tools never enter the payment path.**

## Verify receipts offline (trust no one)

`full_trust` returns a portable Ed25519-signed V7 receipt. Verify it without
trusting any TWZRD server — new receipts use issuer key
`twzrd-receipt-ed25519-v2`; legacy v1 keys remain verify-only during the
bounded compatibility rollout.
(`Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS`), pinned at
<https://intel.twzrd.xyz/.well-known/twzrd-receipt-pubkey>:

```bash
npx twzrd-receipt-verifier <receipt.json> --pubkey Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS
```

## Development

This directory in the public mirror is **`dist/` only**. `npm run build` is a
no-op echo. `npm run demo` exits 1 on purpose — the in-tree demo imports a gate
export this workspace copy does not provide. Use hosted MCP
`https://intel.twzrd.xyz/mcp` or `npx -y twzrd-mcp-server` from npm. Do not
treat this checkout as a from-source MCP build.

---

Links: [Agent Intelligence](https://intel.twzrd.xyz) · [hosted MCP](https://intel.twzrd.xyz/mcp) · [llms.txt](https://intel.twzrd.xyz/llms.txt) · [llms-full.txt](https://intel.twzrd.xyz/llms-full.txt) · [OpenAPI](https://intel.twzrd.xyz/openapi.json)

License: MIT
