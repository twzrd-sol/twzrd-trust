# P0 STATUS — consumer adjacency pack

Worktree: `/home/twzrd/worktrees/twzrd-trust-p0-consumer`  
Branch: `p0/consumer-adjacency`  
Base: `origin/main` @ `33c527e` (Eliza source migration workspace #95)  
Date: 2026-09-12

## Explicitly not this work

- **PR #96** remains parked (draft, conflicting). Not opened, rebased, edited, or merged.
- **Not shipped here:** `completionOfPaidIntel`, `agent-commerce-kit` checkpoint, duplicate docs pin `6a7f210`.
- No prod touches (docker, intel containers, outbid `:4024`, mint, spend, ClawHub).
- No PR opened; no merge.

## Already on origin/main (shipped — we did not re-land)

| Item | Pin / note |
|---|---|
| Gate + AutoGate / safeFetch | `twzrd-x402-gate@0.9.7` |
| Portable decision receipt | `twzrd.payment_decision.v1` (#85/#86) |
| Docs pin gate/verifier | #87 → gate 0.9.5, verifier `^1.4.0` |
| Eliza migration prep | #89–#95 |
| Live refuse-before-sign demo | `GET /v1/intel/demo-gate` → block, `signer_invocations: 0` |
| Canonical skill | `SKILL.md` / https://intel.twzrd.xyz/skill.md (1.13.17) |

## Added in this worktree only

| Path | Role |
|---|---|
| `twzrd-x402-gate/src/consumer-adjacency.ts` | Pure rail router + Solana action ladder + distinct evidence labels |
| `twzrd-x402-gate/test/consumer-adjacency.test.ts` | 15 TDD tests (offline) |
| `twzrd-x402-gate/examples/consumer-adjacency-demo.ts` | Offline router + live demo-gate, 0 USDC |
| `docs/consumer-adjacency.md` | Hermes/Cursor skill pack: one rule, install ≤5 commands, evidence table |
| `STATUS.md` | This file |

**Not** exported from the public npm surface in this pass (internal `src/` + example). Release export is a separate decision.

## How an external agent installs (≤5 commands)

```bash
npm i twzrd-x402-gate@0.9.7 x402-solana@3.0.0
npm i twzrd-receipt-verifier@^1.4.0   # optional; Path A offline verify floor
curl -fsS https://intel.twzrd.xyz/v1/intel/demo-gate | jq '{verdict:(.steps[]|select(.name=="block_path").verdict),signerInvocations:(.steps[]|select(.name=="block_path").signer_invocations),mode}'
# Then: installTwzrdAutoGate / twzrd.safeFetch on Solana pay paths only — see README
# Stripe/Link/Tempo 402s → stripe-link-cli / mpp-agent, not Solana wash
```

## Verified locally (this session)

```text
npx tsx --test test/consumer-adjacency.test.ts
→ 15 pass / 0 fail

npx tsx examples/consumer-adjacency-demo.ts
→ demo-gate: verdict=block, approved=false, signerInvocations=0, mode=no_spend, ok=true
→ 0 USDC
```

## Product split reminder

TWZRD trust/gate ≠ outbid board ≠ witness.  
Evidence: witness shopping receipt ≠ payment_decision.v1 ≠ V6/V7 intel receipt.
