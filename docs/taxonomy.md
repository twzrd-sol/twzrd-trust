# TWZRD Architecture & Concepts Reference

This document defines key concepts and architectural components across the TWZRD trust and spend-control ecosystem.

---

## Core Taxonomy

| Term | Category | Description |
|---|---|---|
| **`safeFetch`** | SDK Primary | High-level fetch wrapper in `twzrd-x402-gate` (`twzrd.safeFetch`) that intercepts 402 responses, verifies counterparty trust & policy caps, and refuses risky/over-budget spend with `signerInvocations: 0`. |
| **`ReadinessCard`** | Intel Advisory | Free advisory response from `POST /v1/intel/preflight` containing `decision` (`allow`, `warn`, `block`), `trust_score` (0–100), `can_spend`, risk factors, and recommended budget caps. |
| **`RESET` / AutoGate** | Enforcement | Pre-signature gate installed on a payment client (e.g. `x402-solana` `beforePayment`, `@x402/core` `onBeforePaymentCreation`, or MPP `onChallenge`) that enforces `approved=false` before any private key signs. |
| **`bind-v1`** | Payment Binding | Chain-verifiable payment binding linking an on-chain SPL Token / USDC transfer memo directly to the exact 402 offer that authorized it. Third-party verifiable from public Solana ledger data. |
| **Path A / V6 Receipt** | Paid Intelligence | Optional $0.05 USDC detailed reputation intelligence and portable signed Ed25519 V6 receipt (`GET /v1/intel/trust/{pubkey}`). Offline-verifiable via `twzrd-receipt-verifier`. |
| **Path B Seat** | Hook Integration | A pre-payment hook seated on a host platform's signing loop (e.g. ElizaOS plugin, Daydreams facilitator, PayAI client). |
| **Settle Rail** | Facilitator | Optional facilitator infrastructure that sponsors or brokers transaction submission on behalf of agents. |
| **`merchant_card`** | Counterparty Screen | Free screening endpoint (`GET /v1/intel/merchant_card/{pubkey}`) providing wash trading signals (`wash_flagged: true/false`), provider reputation tier, and corpus membership. |
