# TWZRD Intel for Hermes

Three tools and one skill for agents that pay x402 sellers.

| Tool | What it does | Network |
|---|---|---|
| `twzrd_preflight` | Free readiness card for a `payTo` address: `decision` (allow, warn, block) and `maximum_recommended_spend_usdc` | `POST https://intel.twzrd.xyz/v1/intel/preflight` |
| `twzrd_merchant_card` | Free merchant card: observed settlement history, `wash_flagged`, `decision` (refuse, insufficient_evidence, no_negative_signal) | `GET https://intel.twzrd.xyz/v1/intel/merchant_card/{address}` |
| `twzrd_verify_receipt` | Verifies a saved TWZRD signed receipt against the pinned TWZRD issuer key and returns that key as `issuer_pubkey` | none for the check; the first run installs `twzrd-receipt-verifier@1.4.6` from npm by lockfile |

The skill `twzrd-intel:twzrd-intel` tells the agent when to refuse.

## Requirements

- Hermes 0.23 or later. Python standard library only.
- Node.js 16+ with `npm`, for `twzrd_verify_receipt` only.
- No API key, no wallet, no environment variables.

## Install

Pin the install to one commit of this repository:

```bash
hermes plugins install 'twzrd-sol/twzrd-trust#integrations/hermes-plugin' --ref <40-character commit SHA>
```

The plugin declares no Python dependencies and no environment variables, and it never updates
itself.

## How the verifier runs

- The trusted key is fixed in the plugin (`ISSUER_PUBKEY` in `schemas.py`). It is not a tool
  argument, so the model cannot choose it; a call that passes `pubkey` is refused. Every result
  carries `issuer_pubkey`, the key the receipt was checked against.
- Only that key is trusted. The verifier CLI also accepts two retired TWZRD keys for a receipt
  that names the old key id or none, so the plugin refuses any receipt whose `key_id` is not
  `twzrd-receipt-ed25519-v2` before the verifier runs. Receipts signed by a retired key, and cNFT
  anchor receipts, are out of scope: check those with the CLI directly.
- The receipt file is read once (1 MB limit) and those bytes are piped to the verifier, so the
  file cannot change between the key check and the signature check.
- `verifier/package-lock.json` pins `twzrd-receipt-verifier@1.4.6` and its five dependencies by
  version and integrity hash. The first call runs `npm ci --ignore-scripts` on a copy of that
  lockfile under `~/.cache/twzrd-hermes-plugin/`; later calls run the installed script with `node`
  and make no network call.
- Before every run, each installed file is compared with `verifier/files.sha256`. A cache
  directory with a changed, missing, extra or symlinked file is discarded and reinstalled, and an
  install that does not match the list is never run.
- The child processes get a minimal environment. `node` gets `PATH` and `HOME`. `npm` also gets
  `NPM_CONFIG_CACHE`, `NPM_CONFIG_REGISTRY`, `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG`
  when set, in upper or lower case. On Windows both also get the system variables Node.js needs.
  Provider API keys and every other variable in the Hermes environment are not passed down. That
  includes proxy and CA variables: behind a proxy, set `proxy`, `https-proxy` or `cafile` in your
  `.npmrc` for the first run.
- `max_age_seconds` must be a positive integer. A value that cannot be applied is refused, not
  ignored.

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

The tests replace the Intel host with a loopback stub and the `npm` and `node` child processes
with recorded exit codes.

Moving the verifier pin: change `VERIFIER_PACKAGE` in `tools.py` and `verifier/package.json`,
regenerate `verifier/package-lock.json` (`npm install --package-lock-only --ignore-scripts`), run
`npm ci --ignore-scripts` in a scratch copy and regenerate `verifier/files.sha256` from its
`node_modules` (`sha256sum` of every file except `.package-lock.json` and `.bin/`). CI runs the first command on every pull request.
