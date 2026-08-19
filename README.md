# TWZRD

**Canonical skill** • [`https://intel.twzrd.xyz/skill.md`](https://intel.twzrd.xyz/skill.md) (twzrd-trust **1.13.8**) · [ClawHub `twzrd-trust`](https://clawhub.ai)  
**Buyer gate (npm)** • [`twzrd-x402-gate@0.8.18`](https://www.npmjs.com/package/twzrd-x402-gate) + seat [`x402-solana@2.1.0`](https://www.npmjs.com/package/x402-solana)  
**Live MCP** • [`https://intel.twzrd.xyz/mcp`](https://intel.twzrd.xyz/mcp) (streamable HTTP; tool count drifts — use live `tools/list`, do not hard-code)  
**Self-host mirror** • public wiring only (scoring engine stays private)

TWZRD is the **pre-spend trust gate** for agents paying over x402 on Solana. Vet the
**seller / service** before USDC leaves the wallet. Free CHECK needs no signup; pay
only when you want a portable signed **V6** receipt (Path A). Not a wallet and not a
payment network.

| Object | Meaning |
|--------|---------|
| **CHECK** | Free preflight / ReadinessCard — **advisory** unless you seat a hook |
| **RESET** | Refuse **before sign** on a payment client you control (`twzrd-x402-gate`) |
| **Path A** | You buy TWZRD intel (we are the merchant). Paid proof after money moves |
| **Path B seat** | Hook on a **foreign** host’s signer; success = `signer_invocation_count=0` + `usdc_spent=0` |
| **Settle rail** | Opt-in: we facilitate / cosign gas (`GET /supported` feePayer `4LkEFj…`) — **not** a Path B seat |
| **V6** | Signed **snapshot** of bound score fields at issue time — not “still true now”, not pay/halt |

Install pin source of truth: live skill `metadata.gate_npm` and
`https://intel.twzrd.xyz/.well-known/agent.json` → `capabilities.gate_package`.
If this README and those disagree, **trust the live skill/card**, then open an issue.

Live counts: [`/health`](https://intel.twzrd.xyz/health) — do not freeze corpus numbers here.

---

## Default path (seller-first)

1. **Resources (SOT)** — `GET /v1/intel/resources` (listed | live_402; not the settlement graph)
2. **Merchant card** — `GET /v1/intel/merchant_card/{pay_to}` or MCP `get_merchant_card`
   - Refuse when `wash_flagged=true` (default in gate packages)
3. **Readiness (CHECK)** — `POST /v1/intel/preflight` or MCP `get_readiness_card_tool`
   - `block` → do not pay
   - `warn` → thin/unknown; buy paid trust if spend matters
   - `allow` → established organic seller — still not a vouch for large spends
4. **Optional Path A paid trust** — `GET /v1/intel/trust/{pubkey}?seller_wallet=<seller>` (0.05 USDC) → V6 receipt
5. **Pay the resource** — only after 1–3 (and optional 4)
6. **Optional settle rail** — pin feePayer from `GET /supported` for `twzrd_receipt` + `merchant_attach` on settle

**RESET (pre-sign):** seat `twzrd-x402-gate@0.8.18` on the client that signs. Free CHECK alone does **not** enforce.

```bash
npm i twzrd-x402-gate@0.8.18 x402-solana@2.1.0
```

---

## Quick Start (free CHECK)

```bash
# 1) Free readiness (no signup, no payment)
curl -s -X POST https://intel.twzrd.xyz/v1/intel/preflight \
  -H 'content-type: application/json' \
  -d '{"seller_wallet":"BJGdsDXJFy63eCAnX3UmGfShp8BuqbtkTfcamyRGr7VQ","price_usdc":0.01,"agent_intent":"preflight"}'

# 2) Free merchant card (wash + catalog context)
curl -s https://intel.twzrd.xyz/v1/intel/merchant_card/BJGdsDXJFy63eCAnX3UmGfShp8BuqbtkTfcamyRGr7VQ
```

| Decision | Meaning |
|----------|---------|
| `block` | Do not pay (wash/fleet or hard deny) |
| `warn` | Unknown or thin history — cautious; `can_spend=false` is common and **not** auto-block unless you opt into strict mode |
| `allow` | Established seller in corpus — small spends only; still verify large/recurring |

---

## Packages

| Surface | Pin / path | Role |
|---------|------------|------|
| npm `twzrd-x402-gate` | **@0.8.18** | Buyer RESET: `createTwzrdBeforePaymentHook`, `installTwzrdAutoGate`, hooks |
| npm `x402-solana` | **@2.1.0** | Stock PayAI seat (`beforePayment`) |
| npm `twzrd-receipt-verifier` | **@^1.3.0** (npm latest 1.3.1) | Offline V6 verify — prefer npm; PyPI may lag |
| npm `twzrd-mcp-server` | local signer MCP | Spend-capped local client; prefer hosted intel MCP |
| npm `@wzrd_sol/plugin-trustgate` | published | Embed / facilitator requirer seat — not buyer wrap |
| npm `@wzrd_sol/eliza-plugin` | published | Eliza embed |
| This repo | mirror | Public wiring + skill; not production scoring source |

**PayAI client seam (external):** [x402-solana #39](https://github.com/PayAINetwork/x402-solana/pull/39) — vendor-neutral optional `beforePayment`. Wire TWZRD in *your* process.

---

## Buyer gate (RESET — pre-sign)

Default machine rule: **decision-only** (`gateOnCanSpend: false`) + **wash refuse** (`refuseWashFlagged: true`). Listing a package ≠ hook installed on a foreign host.

```typescript
import { createTwzrdBeforePaymentHook } from "twzrd-x402-gate";
import { createX402Client } from "x402-solana";

const beforePayment = createTwzrdBeforePaymentHook({ /* policy */ });
const client = createX402Client({ beforePayment /* ... */ });
```

```typescript
import { installTwzrdAutoGate } from "twzrd-x402-gate";

const payingFetch = installTwzrdAutoGate((guarded) => yourPayClient.wrap(guarded));
```

Strict opt-in (also block when `can_spend=false`):

```typescript
import { withTwzrdGuard } from "twzrd-x402-gate";

const fetch = withTwzrdGuard(globalThis.fetch, { gateOnCanSpend: true });
```

---

## Settle rail (opt-in facilitator — not Path B seat)

```bash
curl -s https://intel.twzrd.xyz/supported
# exact · Solana mainnet · feePayer 4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE
```

1. Pin payment `extra.feePayer` to `/supported` (not blindly `accepts[0]`).
2. `POST /verify` then `POST /settle` on `https://intel.twzrd.xyz`.
3. Success: on-chain USDC + `twzrd_receipt` (V6) + best-effort `merchant_attach` on `payTo`.

**Path A paid trust 402** may advertise multi-rail external feePayers. That is buying intel from us, not a foreign AutoGate seat.

---

## Live MCP (free tier)

`POST https://intel.twzrd.xyz/mcp` with  
`Accept: application/json, text/event-stream`.

Start with: `get_x402_directory` · `get_merchant_card` · `get_readiness_card_tool` · `evaluate_x402_resource`.  
Prefer HTTP `GET /v1/intel/resources` for resource-join SOT (keeps the MCP surface lean).

Full contract: [`/llms.txt`](https://intel.twzrd.xyz/llms.txt) · [`.well-known/agent.json`](https://intel.twzrd.xyz/.well-known/agent.json)

---

## Path A — paid trust (0.05 USDC) + V6

```
GET https://intel.twzrd.xyz/v1/intel/trust/{pubkey}?seller_wallet=<seller>
```

| Surface | What you get |
|---------|----------------|
| Free CHECK | ReadinessCard — advisory |
| Paid Path A | Model + signed **V6** receipt |

**V6 honesty:** match = issuer attested the **bound** leaf bytes at issue time. Freshness advice (`recheck_after_unix`, `staleness_days`, `score_decay_model`) may sit in JSON **unsigned** — do not treat them as bound. Dual score fields can disagree; hash the leaf, don’t trust display alone. V6 does not decide pay/halt (that is RESET).

Cheap teaser: `GET /v1/intel/quick/{pubkey}` (0.001 USDC).

---

## Verify receipts offline

```bash
curl -s https://intel.twzrd.xyz/.well-known/twzrd-receipt-pubkey

npx twzrd-receipt-verifier@^1.3.0 receipt.json \
  --pubkey <pubkey from well-known>
```

Floor `^1.3.0` (strict domain allowlist + proof-depth + skew caps). Prefer **npm**; PyPI can lag npm.

---

## Related

- Live skill (always refresh): https://intel.twzrd.xyz/skill.md  
- Live agent contract: https://intel.twzrd.xyz/llms.txt  
- OpenAPI: https://intel.twzrd.xyz/openapi.json  
- [twzrd-x402-gate](https://www.npmjs.com/package/twzrd-x402-gate) · [twzrd-receipt-verifier](https://www.npmjs.com/package/twzrd-receipt-verifier)  
- [SECURITY.md](./SECURITY.md)

---

## License

MIT — see [LICENSE](./LICENSE).
