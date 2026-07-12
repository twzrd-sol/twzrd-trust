# Seller graph + pay-guard closeout (2026-07-12)

**Status:** production-validated on `https://intel.twzrd.xyz` (package `0.5.4`; seatbelt unchanged from `0.5.3`).
**Scope:** free discovery → merchant card → `next_action` → AutoGate block before sign.  
**Not claimed:** settlement reliability, real funded allow-path, or third-party independent run (see scoreboard).

## Semantic distinctions (read first)

| Term | Meaning |
|------|---------|
| **Listed** | Present in the TWZRD service catalog from marketplace discovery. Not proof the endpoint still issues a 402. |
| **Challenge-verified (`live_402_verified`)** | TWZRD recently observed a **parseable x402 PaymentRequired challenge** (JSON body and/or `PAYMENT-REQUIRED` header). **Not** "settled successfully" and **not** "guaranteed operational." |
| **Settled** | An on-chain payment completed. Separate field and proof class — out of scope for this closeout. |

## 1. Discovery → card → `next_action`

Public surface: `GET https://intel.twzrd.xyz/v1/intel/merchant_card/{pay_to}`  
Card version: `merchant_card_v1.4`.

### Challenge-verified seller (StableEnrich)

- Solana receive wallet (pay_to): use the merchant's public pay_to from the card; do not treat directory presence alone as spend authorization.
- Dogfood snapshot: **8 of 9** listed endpoints had `live_402_verified=true`.
- `next_action` when at least one endpoint is challenge-verified and wash is clear:  
  `decision=no_negative_signal`, `recommended.step=proceed_small_spend`  
  (still **not** a vouch; free card is down-only).

### Listed-but-unverified counterexample

- Merchants with catalog rows and **zero** challenge-verified endpoints return:  
  `decision=listed_unverified`, `recommended.step=quick`  
- This is intentional: **listed inventory must not receive `proceed_small_spend`.**

### Ladder asymmetry (intentional)

| Situation | `next_action` |
|-----------|----------------|
| Listed services + zero challenge-verified | `listed_unverified` → `quick` |
| No listed services + wallet-level corpus demand | may still `proceed_small_spend` |
| ≥1 challenge-verified + no wash | `no_negative_signal` → `proceed_small_spend` |

## 2. AutoGate block trace (pay-time enforcement)

Composition under test: `installTwzrdAutoGate(payWrap, { rawFetch, gateOnCanSpend: true, failOpen: false })`  
Resource: live x402 challenge endpoint.  
Policy: block when preflight reports `can_spend=false`.

Observed order (instrumented pay client; **no real USDC**):

1. Raw fetch receives HTTP 402  
2. TWZRD preflight runs against `https://intel.twzrd.xyz/v1/intel/preflight`  
3. Preflight: `decision=warn`, `can_spend=false`  
4. Guard throws: `payment blocked: twzrd_can_spend_false`  
5. **`signInvocations: 0`** (signer never called)

Also proven in the same harness (non-settlement):

- Decision-only policy (`gateOnCanSpend=false`): preflight then simulated sign  
- Intel outage + `failOpen=false`: fail-closed, no sign  
- Wrong composition (guard outside an internalizing pay client): too late — documented anti-pattern  

**Decisive artifact:** hook decision + **signer invocation count 0**, not readiness alone.

### Install

```bash
npm i twzrd-x402-gate@0.5.4
```

### Official x402 client hook (recommended)

```typescript
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { installTwzrdX402ClientHook } from "twzrd-x402-gate";

const client = new x402Client();
client.register("solana:*", new ExactSvmScheme(svmSigner));
installTwzrdX402ClientHook(client, { gateOnCanSpend: true });

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
```

### Raw-fetch composition

```typescript
import { installTwzrdAutoGate } from "twzrd-x402-gate";

const payingFetch = installTwzrdAutoGate(
  (guarded) => wrapFetchWithPayment(guarded, client),
  { gateOnCanSpend: true, failOpen: false },
);
```

Runnable instrumented example (no funds):  
[`examples/zero-spend-guard-check.mjs`](./examples/zero-spend-guard-check.mjs)

## 3. Metric snapshot (public)

Captured from `GET https://intel.twzrd.xyz/health` → `service_catalog`. **Listed ≠ live** — directory breadth and challenge-verified counts diverge by design.

| Metric | At closeout (2026-07-12 AM) | Current (live `/health`) |
|--------|----------------------------|--------------------------|
| Gate package | 0.5.3 | `twzrd-x402-gate@0.5.4` on npm |
| `service_count` | 549 | 562 |
| `covered_paytos` | 152 | 155 |
| `live_402_service_count` | 148 | 186 (hourly crawl; rising) |

## 4. Crawler truth

Failure classes addressed in production:

1. **x402 v2 header-only challenges** — empty body + `PAYMENT-REQUIRED` base64 JSON → now parsed.  
2. **POST-only endpoints** — GET 405 → one POST `{}` retry (no settlement).  
3. **Ladder honesty** — listed + zero verified → `listed_unverified`.

Independent hourly probes add challenge-verified evidence on top of directory breadth.

## 5. What this does *not* prove

- Independent **external** team run (open mandate).  
- Real funded allow-path with a live wallet signature.  
- Continuous liveness TTL on previously verified rows.  
- Settlement success rates or delivery outcomes.

## 6. Five-minute external test (no funds)

Target: one warm integration whose client can wrap fetch **before** wallet signing.

Expected:

1. Hit free merchant card / preflight for a known seller (or a live 402 resource preflight marks `can_spend=false`).  
2. With AutoGate / `gateOnCanSpend=true`, observe block when `can_spend=false`.  
3. Report: **decision**, **reason**, **signer invocation count** (expect **0** on block).

Do **not** send real USDC for this test.

### Ask template

```
Quick 5-minute no-funds check on TWZRD pay-guard:

1) Read: https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proofs/seller-graph-payguard-closeout-2026-07-12.md
2) Run your client with TWZRD immediately before wallet signing (installTwzrdAutoGate or installTwzrdX402ClientHook with gateOnCanSpend=true).
3) Use an instrumented or unfunded signer against a live 402 that preflight marks can_spend=false.

Expected strict-policy result:
  decision: block (or warn)
  reason: twzrd_can_spend_false
  signInvocations: 0

Please send back: decision, reason, signer invocation count, and whether the hook ran before sign.
```

## Scoreboard

| Item | Status |
|------|--------|
| Stable proof URL | **this file on `twzrd-trust` `main`** |
| PayAI pre-sign PR | [#38](https://github.com/PayAINetwork/x402-solana/pull/38) or [#39](https://github.com/PayAINetwork/x402-solana/pull/39) (either/or; maintainer pick) |
| Run attribution (0.5.4) | live on intel preflight observe |
| External guard run | pending (foreign signer=0) |
| Independent transcript | pending |

---

*Wallets cited only where already public on merchant cards. No private repository links.*