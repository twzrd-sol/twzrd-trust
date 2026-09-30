# TWZRD

**Don't let your agent sign blind.**  
Spend control and counterparty trust for agents that buy: the x402 service they are about to pay (Solana, and Base) and the store product they are about to buy.
Vet the seller **before** USDC leaves the wallet, cap and ledger every spend, and bind each settled payment to the exact offer it paid for (**bind-v1** — verifiable from public chain data). Advisory preflight is free ($0). Signed execution clearance is **$0.001** (`twzrd.payment_decision.v1` / `quickCheck`). Checking a store product listing before buying is free too ([product listings](#product-listings-check-the-product-before-you-buy)). Not a wallet. Not a payment network. Not Catena's Agent Commerce Kit — the walkthrough lives in [docs/COMMERCE-KIT.md](./docs/COMMERCE-KIT.md).

**Canonical skill (always refresh)** • https://intel.twzrd.xyz/skill.md (skill `twzrd-trust`; the live copy carries its version) · [ClawHub `twzrd-trust`](https://clawhub.ai)  
**Spend-control SDK (npm)** • [`twzrd-x402-gate@0.11.2`](https://www.npmjs.com/package/twzrd-x402-gate) + seat [`x402-solana@3.0.0`](https://www.npmjs.com/package/x402-solana)  
**Live MCP** • https://intel.twzrd.xyz/mcp (streamable HTTP; free tools for x402 service checks and product-listing checks)  
**Shopping check** • free `check_listing` on the hosted MCP · report: https://twzrd.xyz/shopping-check/vuori-kore/  
**Agent contract** • https://intel.twzrd.xyz/llms.txt · https://intel.twzrd.xyz/.well-known/agent.json

---

## 60-second deterministic free demo

Run this one-line command with **no wallet, no API key, and no configuration**:

```bash
curl -fsS https://intel.twzrd.xyz/v1/intel/demo-gate | jq '{verdict: (.steps[] | select(.name == "block_path") | .verdict), approved: (.steps[] | select(.name == "block_path") | .approved), signerInvocations: (.steps[] | select(.name == "block_path") | .signer_invocations), mode, ok}'
```

Without `jq`, run: `curl -fsS https://intel.twzrd.xyz/v1/intel/demo-gate`

Expected output:
```json
{
  "verdict": "block",
  "approved": false,
  "signerInvocations": 0,
  "mode": "no_spend",
  "ok": true
}
```

*Blocks happen before your signer is invoked (`signerInvocations: 0`) — zero USDC at risk.*

---

## From this repo

This checkout is a public monorepo, not `npm install twzrd-x402-gate`. CI is
root `npm ci` then `npm run ci` (Node 20). Do **not** `npm ci` inside
`twzrd-x402-gate/` — gate typecheck needs sibling `twzrd-log-verifier` deps
from the root lockfile.

```bash
npm ci
npm run build
npm run typecheck
npm test --workspace=twzrd-x402-gate
npm run gate-eval-refuse --workspace=twzrd-x402-gate
```

`gate-eval-refuse` is the hello-world that closes (0 USDC, `signer_invocation_count: 0`).
It needs egress to `https://intel.twzrd.xyz`. Artifact dirs (`eliza-plugin/`,
`plugin-trustgate/`, `twzrd-mcp-server/`) are `dist/` mirrors — do not try to
build or demo them locally. Hosted MCP: `https://intel.twzrd.xyz/mcp`.

---

## Quickstart

### 1. Install

```bash
npm install twzrd-x402-gate@0.11.2 x402-solana@3.0.0
```

### 2. Wrap paid fetches with spend controls

```ts
import { twzrd } from "twzrd-x402-gate";

const result = await twzrd.safeFetch("https://merchant.example/paid-endpoint", {
  maxSpend: "0.10",            // per-call cap AND cumulative budget in USD
  allowNetworks: ["solana"],   // allowed settlement networks
  requireOfferBinding: true,   // demand an on-chain verifiable bind-v1 receipt
  pay: async ({ url, paymentRequired, selected }) => {
    // Your existing x402 client signs here — e.g. @x402/fetch + your signer
    return await myWallet.payX402(url, paymentRequired, selected);
  },
});

// On block: result.verdict === "block", result.signerInvocations === 0
```

### 3. Or hook an existing client

```ts
import { createX402Client } from "x402-solana";
import { createTwzrdBeforePaymentHook } from "twzrd-x402-gate";

const client = createX402Client({
  wallet,
  network: "solana",
  beforePayment: createTwzrdBeforePaymentHook({ refuseWashFlagged: true }),
});
```

---

## Commerce loop

One path. Install `twzrd-x402-gate@0.11.2`. Free preflight does not enforce; AutoGate on the pay path does.

1. **Install the gate** — `npm i twzrd-x402-gate@0.11.2` then `installTwzrdAutoGate`
2. **Cold-start (optional)** — `npx twzrd-cold-start` writes a default-deny `policy.json` from a pinned foreign 402 diet (0 USDC; not a TWZRD bazaar)
3. **Directory** — `GET /v1/intel/resources` (or `listDirectoryCallables`) — bazaars list; TWZRD sits beside
4. **Preflight** — free ReadinessCard + merchant_card wash refuse
5. **Pay only when policy allows** — blocks have `signerInvocations === 0`
6. **Clearance ($0.001)** — `quickCheck` + portable `twzrd.payment_decision.v1` (`npx twzrd-payment-decision --verify`)
7. **Evidence bundle** — `exportEvidenceBundle` / `npx twzrd-evidence-bundle`
8. **Optional Path A** — $0.05 V7 intel receipt. Not the primary SKU.

Refuse-first demo (0 USDC): `npx tsx twzrd-x402-gate/examples/commerce-kit.ts`  
Cold-start diet (0 USDC): `npx twzrd-cold-start`  
Walkthrough: [docs/COMMERCE-KIT.md](./docs/COMMERCE-KIT.md)

## Default Protection Sequence

1. **Discover** — `GET /v1/intel/resources` (resource catalog)
2. **Merchant card** — `GET /v1/intel/merchant_card/{pay_to}` (refuse if `wash_flagged: true`)
3. **Preflight** — `POST /v1/intel/preflight` → ReadinessCard (allow / warn / block)
4. **Clearance ($0.001)** — `GET /v1/intel/quick/{pay_to}` + `twzrd.payment_decision.v1`
5. **Pay** — sign only when preflight & spend policy allow

```bash
# Free preflight (no signup, no wallet)
curl -s -X POST https://intel.twzrd.xyz/v1/intel/preflight \
  -H 'content-type: application/json' \
  -d '{"seller_wallet":"46vMcwuC4sK11sB3gkLhyA7J7GEwfkhn5rFyDtihBwqe","price_usdc":0.01,"agent_intent":"preflight"}'
```

---

## Product listings: check the product before you buy

The second lane is for an agent buying a product from a store, not paying an x402 seller. Before it buys, it calls `check_listing(product_url, declared_unit_price)` on the hosted MCP. The call is free and read-only: it does not fetch the store page, open a checkout, or move money.

```bash
# Declared $79 against a card that advertises $78: refused
curl -sS https://intel.twzrd.xyz/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_listing","arguments":{"product_url":"https://checkout.vuoriclothing.com/products/kore-short-ink","declared_unit_price":"79"}}}' \
  | sed -n 's/^data: //p' \
  | jq '.result.structuredContent | {result, reason, price_check, needs_approval, authorizes_spend}'
```

Expected output while the reference card is current and advertises $78:
```json
{
  "result": "check_failed",
  "reason": "phantom_markup_detected",
  "price_check": "above_advertised",
  "needs_approval": true,
  "authorizes_spend": false
}
```

| You call with | `result` | `price_check` | `needs_approval` |
|---|---|---|---|
| The advertised price | `advertised` | `verified` | `false` |
| A price above it | `check_failed` (`phantom_markup_detected`) | `above_advertised` | `true` |
| A price below it, including 0 | `advertised` | `discount_unverified` | `true` |
| No `declared_unit_price` | `advertised` | `null` (only the product is checked, not the price) | `false` |
| A URL no published card covers | `unknown_seller` (not a clean seller) | `null` | `true` |
| A card past its `expires_at` | `expired` | | `true` |

`needs_approval: true` means a human approves before the agent buys. A card that advertises no price also sets it. `authorizes_spend` is always `false`: a matching card is evidence for your own spend policy, not permission to spend.

What a card is, and what it is not:

- **One reference card today:** Vuori Kore Short, Ink, US. It is an observer card (TWZRD's capture of the store's public pages), not a merchant attestation. Each published card carries an `expires_at`; after it, `check_listing` returns `expired`.
- **Advertised means a captured page said it.** Purchase completion and delivery are not verified.
- **Read the card and its evidence:** `get_claim` and `get_evidence`. `get_shopping_check` returns the Agent Shopping Check report, the same one as https://twzrd.xyz/shopping-check/vuori-kore/ and `GET https://intel.twzrd.xyz/v1/shopping-check/vuori-kore`.
- **Verify it without trusting the server:** `get_publication` returns the Ed25519-signed publication record and its verify key. Pin the publisher key fingerprint below, never one taken from the same response. Verify the record's Ed25519 signature with that key, then check that the sha256 of the `text` returned by `get_claim` and `get_evidence` matches the record's `artifact_digest` and `evidence_digest`.

  ```text
  sha256:903d0d041e2d82fc0dd6f5252b4e904121e113e498d00b7385cad6061b4881af
  ```

- **Paid, optional:** `GET https://intel.twzrd.xyz/v1/intel/checkout-brief` ($0.001 USDC via x402) binds your `cart_hash` to the card before a buyer-approved Shop Pay checkout. It carries `needs_approval` and `authorizes_spend: false`, and it does not pay the merchant. A product URL that does not match the card, or an expired card, returns 404 before any 402; a declared price above the advertised one returns 409 before any 402.

---

## Packages & References

| Package | Pin | Description |
|---|---|---|
| `twzrd-x402-gate` | **@0.11.2** | Spend-control SDK (`twzrd.safeFetch`) + pre-sign gate hooks |
| `x402-solana` | **@3.0.0** | Compatible Solana client seat for the pre-payment gate |
| `twzrd-receipt-verifier` | **@^1.4.0** | Standalone offline verifier for Ed25519 V5/V6/V7 receipts |
| `twzrd-mcp-server` | **@0.5.5** (this tree) | Local spend-capped auto-pay client (6 tools); prefer hosted MCP |
| `@wzrd_sol/plugin-trustgate` | **@^0.3.7** | Eliza / facilitator adapter |

- **Commerce loop (don't sign blind):** [docs/COMMERCE-KIT.md](./docs/COMMERCE-KIT.md)
- **Step-by-step Guide:** [QUICKSTART.md](./QUICKSTART.md)
- **Concepts & Architecture:** [docs/taxonomy.md](./docs/taxonomy.md)
- **V6/V7 Receipt Specification:** [docs/receipt-v6-spec.md](./docs/receipt-v6-spec.md)
- **Receipt Transparency Log:** [docs/transparency-log.md](./docs/transparency-log.md) (in-repo `twzrd-log-verifier` — not on npm)
- **Receipt Verification & Ground Truth:** [REVIEW.md](./REVIEW.md)
- **Security Policy:** [SECURITY.md](./SECURITY.md) · [docs/security-assurance.md](./docs/security-assurance.md)
