# Public proof thread — pay-guard + live seller graph (2026-07-12)

Thread copy for X / GitHub / community posts. **Do not** lead with the caveated AgentCash paid `/trust` path.

---

## 1/ What shipped

TWZRD is a pre-spend trust layer for agents paying over x402 on Solana.

Not a bigger directory. Three separable claims:

- **Inventory:** 549 catalog services, 148 independently challenge-verified (`listed ≠ live`)
- **Intelligence:** free merchant card + preflight (`allow` / `warn` / `block`, `next_action`)
- **Enforcement:** `installTwzrdAutoGate` blocks before wallet sign (`signInvocations: 0`)

---

## 2/ The seatbelt proof (zero USDC)

```bash
npm i twzrd-x402-gate@0.5.3
node zero-spend-guard-check.mjs   # from public harness below
```

Expected strict-policy block:

```
decision: block (or warn)
reason: twzrd_can_spend_false
signInvocations: 0
```

Harness: https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proofs/examples/zero-spend-guard-check.mjs  
Closeout: https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proofs/seller-graph-payguard-closeout-2026-07-12.md

---

## 3/ Free path (no install)

```bash
curl -s -X POST https://intel.twzrd.xyz/v1/intel/preflight \
  -H 'content-type: application/json' \
  -d '{"seller_wallet":"<payTo>","price_usdc":0.05}' | jq '.readiness_card'
```

Remote MCP (23 tools, no wallet): `https://intel.twzrd.xyz/mcp`

---

## 4/ External validation (2s.io)

Our crawler found a live fee-payer lottery bug in 2s.io's Solana x402 path — challenge and retry advertised different fee payers. Maintainer fixed same day; 14/14 settlements after fix (was ~1-in-3).

That is diagnosis in someone else's payment path, not a dashboard score.

Thread: https://github.com/2s-io/sdk/issues/3

---

## 5/ What we are asking integrators

Five minutes, no funds. Wire TWZRD before sign (client) or before settle (rail, fail-open).

Return: `package_version`, `policy_mode`, `decision`, `reason`, `signer_invocation_count`.

Warm asks in flight:
- 2s.io: https://github.com/2s-io/sdk/issues/3#issuecomment-4950049214
- PayAI: https://github.com/PayAINetwork/x402-solana/issues/37
- AgentCash: https://github.com/Merit-Systems/agentcash-skills/issues/19

---

## 6/ What we are not claiming

- Organic demand at scale (open)
- Paid-first onboarding (day0 external paid still 0)
- Delivery/outcome oracle for purchased services
- AO / CCM deposit loop as the viral app

The open job: **one external stack makes this default config** so other agents inherit it.

`https://intel.twzrd.xyz`