# TWZRD

**Don't let your agent sign blind.**  
Spend control and counterparty trust for agents paying over x402 on Solana (and Base).
Vet the seller **before** USDC leaves the wallet, cap and ledger every spend, and bind each settled payment to the exact offer it paid for (**bind-v1** — verifiable from public chain data). Free preflight → optional paid V6 receipt. Not a wallet. Not a payment network. Not Catena's Agent Commerce Kit — the walkthrough lives in [docs/COMMERCE-KIT.md](./docs/COMMERCE-KIT.md).

**Canonical skill (always refresh)** • https://intel.twzrd.xyz/skill.md (twzrd-trust **1.13.16**) · [ClawHub `twzrd-trust`](https://clawhub.ai)  
**Spend-control SDK (npm)** • [`twzrd-x402-gate@0.9.3`](https://www.npmjs.com/package/twzrd-x402-gate) + seat [`x402-solana@3.0.0`](https://www.npmjs.com/package/x402-solana)  
**Live MCP** • https://intel.twzrd.xyz/mcp (streamable HTTP — 24 tools)  
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

## Quickstart

### 1. Install

```bash
npm install twzrd-x402-gate@0.9.3 x402-solana@3.0.0
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

One path. Install `twzrd-x402-gate@0.9.3`. Free preflight does not enforce; AutoGate on the pay path does.

1. **Install the gate** — `npm i twzrd-x402-gate@0.9.3` then `installTwzrdAutoGate`
2. **Directory** — `GET /v1/intel/resources` (or `listDirectoryCallables`) — bazaars list; TWZRD sits beside
3. **Preflight** — free ReadinessCard + merchant_card wash refuse
4. **Pay only when policy allows** — blocks have `signerInvocations === 0`
5. **Verify** — bind-v1 / V6 (optional ACK-Pay VC). No second passport format
6. **Evidence bundle** — `exportEvidenceBundle` / `npx twzrd-evidence-bundle`

Refuse-first demo (0 USDC): `npx tsx twzrd-x402-gate/examples/commerce-kit.ts`  
Walkthrough: [docs/COMMERCE-KIT.md](./docs/COMMERCE-KIT.md)

## Default Protection Sequence

1. **Discover** — `GET /v1/intel/resources` (resource catalog)
2. **Merchant card** — `GET /v1/intel/merchant_card/{pay_to}` (refuse if `wash_flagged: true`)
3. **Preflight** — `POST /v1/intel/preflight` → ReadinessCard (allow / warn / block)
4. **Optional V6 Receipt** — `GET /v1/intel/trust/{pay_to}` ($0.05 USDC paid receipt)
5. **Pay** — sign only when preflight & spend policy allow

```bash
# Free preflight (no signup, no wallet)
curl -s -X POST https://intel.twzrd.xyz/v1/intel/preflight \
  -H 'content-type: application/json' \
  -d '{"seller_wallet":"46vMcwuC4sK11sB3gkLhyA7J7GEwfkhn5rFyDtihBwqe","price_usdc":0.01,"agent_intent":"preflight"}'
```

---

## Packages & References

| Package | Pin | Description |
|---|---|---|
| `twzrd-x402-gate` | **@0.9.3** | Spend-control SDK (`twzrd.safeFetch`) + pre-sign gate hooks |
| `x402-solana` | **@3.0.0** | Compatible Solana client seat for the pre-payment gate |
| `twzrd-receipt-verifier` | **@^1.3.0** | Standalone offline verifier for Ed25519 V6 receipts |
| `twzrd-mcp-server` | **@0.5.2** | Local spend-capped auto-pay client (6 tools) |

- **Commerce loop (don't sign blind):** [docs/COMMERCE-KIT.md](./docs/COMMERCE-KIT.md)
- **Step-by-step Guide:** [QUICKSTART.md](./QUICKSTART.md)
- **Concepts & Architecture:** [docs/taxonomy.md](./docs/taxonomy.md)
- **V6 Receipt Specification:** [docs/receipt-v6-spec.md](./docs/receipt-v6-spec.md)
- **Receipt Verification & Ground Truth:** [REVIEW.md](./REVIEW.md)
- **Security Policy:** [SECURITY.md](./SECURITY.md) · [docs/security-assurance.md](./docs/security-assurance.md)
