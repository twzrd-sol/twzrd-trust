# Reproduce a Solana seller-policy refusal offline

From a clean checkout at the repository root, with Node 20, 22, or 24:

```bash
npm ci
npm run build
node twzrd-x402-gate/scripts/run-offline-refusal-proof.mjs > offline-refusal-proof.json
```

The final command prints JSON and exits nonzero if any required check fails.
The install needs access to npm; the proof itself permits only literal
loopback TCP and local IPC. It needs no wallet, private key, hosted TWZRD
service, public RPC, chain transaction, or spend. This is a checkout tool;
the command is not advertised as part of an already published npm release.

## What runs

The harness extends the existing real-client proof. It supplies synthetic
mainnet-USDC payment requirements, loopback merchant/RPC responses, local
seller decisions, and a counting signer that returns zero-filled signatures.
Installed client packages still perform requirement selection, hook dispatch,
SPL transaction construction, and the signed HTTP retry.

| Client | Tested installed versions | Hook |
|---|---|---|
| Official x402 | `@x402/core`, `@x402/fetch`, `@x402/svm` 2.27.0; `@solana/kit` 5.5.1 | `onBeforePaymentCreation` |
| Stock Solana | `x402-solana` 3.0.1 | `beforePayment` |

[The machine-readable matrix](../twzrd-x402-gate/proof-compatibility.json)
is checked against runtime-resolved package versions. A changed lockfile or
unexpected package resolution fails rather than silently claiming that an
untested version passed. Re-run the tests and review the transcript before
updating the matrix. CI runs the proof separately on Node 20, 22, and 24.

Each real client runs three cases:

| Case | Decision | Signer calls | Paid retries | Simulated settlements | Chain spend |
|---|---|---:|---:|---:|---:|
| Seller-policy block | `block`, approved false | 0 | 0 | 0 | 0 |
| Clean control | `allow`, approved true | 1 | 1 | 1 | 0 |
| Same blocked seller, gate absent | no gate decision | 1 | 1 | 1 | 0 |

The block must name `twzrd_decision_block`; an RPC failure, price cap, unknown
network, or unavailable signer cannot stand in for a seller-policy refusal.
The clean and gate-absent controls prove the fixture can reach the signer.
Allowed messages are decoded to compare amount, asset, buyer authority, and
recipient ATA with the approved requirement. A fake 200 alone does not pass.

## Transcript contract

Output uses `twzrd.offline_refusal_proof.v1`, described by the
[JSON Schema](../twzrd-x402-gate/schemas/refusal-proof.v1.schema.json).
It includes installed versions, exact selected requirements and resource,
decision/reason, approval, signer invocation count, broadcast count, payment
retry count, simulated settlement count, spend, decoded signer calls, RPC
methods, named checks, and verification outcomes.

`transaction_broadcast_count` counts attempts to invoke a broadcast RPC in
the fixture and must be zero. The fixture rejects unsupported RPC methods.
`simulated_settlement_count` labels the merchant's synthetic closeout and is
separate from actual broadcasts and spend. No real USDC balance is queried
or moved. `external_adoption` is always false: these are our local fixtures,
even though they exercise real third-party client code.

The network guard rejects external fetch and TCP destinations. Its denial
counter must remain zero; an SDK attempting to fall back to public RPC makes
the proof fail, even if the gate catches the resulting connection error.
It is a test-process tripwire, not a sandbox for untrusted code.

## A limit the proof deliberately detects

The seventh case installs a later hook on the official client that rewrites
the recipient after TWZRD approves it. The counting signer observes the
different recipient, and the binding check must detect it. This case passes
only when that existing hook-chain limitation is reproduced and detected.
It does not claim to fix the limitation or constrain a non-cooperating signer.
`verified=true` means every declared proof and control behaved as expected.

## Check release/install drift separately

```bash
node --test scripts/check-gate-release-drift.test.mjs
node scripts/check-gate-release-drift.mjs
```

The first command uses local HTTP responses. The second makes free GETs to
npm metadata, service health, agent metadata, `llms.txt`, and `skill.md`.
It fails on outages, missing pins, or a release/install pin that differs from
the checked-out package version. A stale install alongside a current one
also fails. It never signs, pays, deploys, or changes hosted content.

The networked drift workflow runs on main changes to its relevant files,
daily, or by manual dispatch. PR proof jobs remain independent of hosted
service availability. The normal repository build, typecheck, tests, and
dependency audit still apply alongside the proof jobs.
