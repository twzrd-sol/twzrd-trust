# TWZRD Intel for Hermes

Three tools and one skill for agents that pay x402 sellers.

| Tool | What it does | Network |
|---|---|---|
| `twzrd_preflight` | Free readiness card for a `payTo` address: `decision` (allow, warn, block) and `maximum_recommended_spend_usdc` | `POST https://intel.twzrd.xyz/v1/intel/preflight` |
| `twzrd_merchant_card` | Free merchant card: observed settlement history, `wash_flagged`, `decision` (refuse, insufficient_evidence, no_negative_signal) | `GET https://intel.twzrd.xyz/v1/intel/merchant_card/{address}` |
| `twzrd_verify_receipt` | Verifies a saved TWZRD signed receipt against a pinned Ed25519 key | none for the check; the first run downloads `twzrd-receipt-verifier@1.4.4` from npm |

The skill `twzrd-intel:twzrd-intel` tells the agent when to refuse.

## Requirements

- Hermes 0.23 or later. Python standard library only.
- Node.js 16+ with `npx`, for `twzrd_verify_receipt` only.
- No API key, no wallet, no environment variables.

## Install

Pin the install to one commit of this repository:

```bash
hermes plugins install 'twzrd-sol/twzrd-trust#integrations/hermes-plugin' --ref <40-character commit SHA>
```

The plugin declares no Python dependencies and no environment variables, and it never updates
itself.

## What leaves your machine

The seller address, and the resource URL if you pass one, go to `intel.twzrd.xyz`. Receipt files
are read locally and never uploaded. The plugin never signs, pays, or holds keys.

## Semantics

- `ok: false` from a lookup means the seller was not screened. Treat it as a refusal.
- `wash_flagged: true` means refuse. `wash_flagged: null` means never evaluated, not clean.
- The signals are advisory and describe observed settlement history, not identity.

## Check it

From the repository root:

```bash
python3 integrations/hermes-plugin/tests/test_plugin.py      # offline: no network, no Node.js
hermes plugins doctor integrations/hermes-plugin --ci        # manifest, import, registration
hermes plugins validate integrations/hermes-plugin           # catalog admission checks
```

The tests replace the Intel host with a loopback stub and the verifier with a recorded exit
code. CI runs the first command on every pull request.
