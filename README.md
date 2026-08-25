# TWZRD

**Pre-spend trust gate for agents paying over x402 on Solana.**  
Vet the seller **before** USDC leaves the wallet. Free CHECK → optional paid V6 receipt. Not a wallet. Not a payment network.

**Canonical skill (always refresh)** • https://intel.twzrd.xyz/skill.md (twzrd-trust **1.13.16**) · [ClawHub `twzrd-trust`](https://clawhub.ai)  
**Buyer gate (npm)** • [`twzrd-x402-gate@0.9.1`](https://www.npmjs.com/package/twzrd-x402-gate) + seat [`x402-solana@3.0.0`](https://www.npmjs.com/package/x402-solana)  
**Live MCP** • https://intel.twzrd.xyz/mcp (streamable HTTP — use live `tools/list`)  
**Agent contract** • https://intel.twzrd.xyz/llms.txt · https://intel.twzrd.xyz/.well-known/agent.json

Install pin source of truth is the live skill + agent.json. If this README disagrees, **trust the live surfaces** and open an issue.

---

## For agents (one-command start)

```bash
# 1. Install the skill
npx clawhub install twzrd-trust

# 2. Or seat the pre-sign gate directly
npm install twzrd-x402-gate@0.9.1 x402-solana@3.0.0
```

```ts
import { createX402Client } from "x402-solana";
import { createTwzrdBeforePaymentHook } from "twzrd-x402-gate";

const client = createX402Client({
  wallet,
  network: "solana",
  beforePayment: createTwzrdBeforePaymentHook({ refuseWashFlagged: true }),
});
```

**Rule:** Every external x402 payment should be evaluated before signing. Free preflight is advisory. The gate (RESET) enforces on your controlled client (signer_invocation_count = 0 on block).

---

## Objects

| Object | Meaning |
|--------|---------|
| **CHECK** | Free preflight / ReadinessCard (allow \| warn \| block) — advisory unless hooked |
| **RESET** | Refuse **before sign** via `twzrd-x402-gate` on a payment client you control |
| **Path A** | Optional paid intel + portable signed **V6** receipt (0.05 USDC) |
| **Path B seat** | Hook on foreign host’s signer; success = signer never invoked |
| **Settle rail** | Opt-in facilitator (`GET /supported` feePayer) — separate from Path B |

---

## Default path (seller-first)

1. Discover — `GET /v1/intel/resources` (resource join SOT)
2. Merchant card — `GET /v1/intel/merchant_card/{pay_to}` (refuse if `wash_flagged`)
3. Preflight — `POST /v1/intel/preflight` → ReadinessCard
4. Optional Path A — paid V6 if deeper proof needed
5. Pay only after the above (and after gate if you control signing)
6. Optional settle through TWZRD for free `twzrd_receipt` + `merchant_attach`

```bash
# Free preflight (no signup)
curl -s -X POST https://intel.twzrd.xyz/v1/intel/preflight \
  -H 'content-type: application/json' \
  -d '{"seller_wallet":"BASE58_PAY_TO","price_usdc":0.01,"agent_intent":"preflight"}'
```

---

## Packages

| Surface | Pin | Role |
|---------|-----|------|
| `twzrd-x402-gate` | **@0.9.1** | Buyer RESET (beforePayment / AutoGate) |
| `x402-solana` | **@3.0.0** | Stock seat for the gate |
| `twzrd-receipt-verifier` | **@^1.3.0** | Offline V6 verify |
| This repo | mirror | Public source + skill mirror; production scoring is hosted |

---

## Protect discovery

- ClawHub / OpenClaw skill
- MCP listings (PulseMCP etc.)
- x402 resource-join + marketplace overlay
- `.well-known/agent.json` + `llms.txt` + `skill.md`
- Preflight telemetry

No private discovery channel identified. Success metric = live discovery → preflight traffic, not stars.

---

## Related

- Live skill (refresh always): https://intel.twzrd.xyz/skill.md  
- OpenAPI: https://intel.twzrd.xyz/openapi.json  
- SECURITY.md · LICENSE (MIT)

**Topics for discovery:** `x402` `solana` `mcp` `agent-trust` `pre-spend` `skill` `preflight` `trust-gate`
