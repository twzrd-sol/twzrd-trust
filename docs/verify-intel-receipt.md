# Verify a TWZRD intel receipt

**Lineage: TWZRD-operated (dogfood).** The receipt on this page was bought by a wallet TWZRD
funds, from TWZRD's own paid route, and it scores TWZRD's own seller wallet. It shows that a
receipt TWZRD issues as a seller can be checked from the buyer's side with public material
only. It is not evidence of outside demand.

`GET https://intel.twzrd.xyz/v1/intel/trust/{pubkey}` costs 0.05 USDC over x402. Its 200
response carries two things a buyer can check without asking TWZRD again:

- `twzrd_receipt`: a V7 receipt. The fields of the answer are packed into a Keccak-256 leaf,
  and the leaf is signed with Ed25519.
- `log_inclusion`: a proof that the leaf is in the receipt transparency log, under a tree
  head signed by the same key.

This page takes one receipt from a settled mainnet payment and checks it in five steps. No
step needs a TWZRD account, API key or secret. Steps 2 to 4 make no network call once the
tools are installed.

`GET /v1/intel/quick/{pubkey}` (0.001 USDC) is the cheaper paid route. It returns no signed
receipt, so there is nothing to verify offline after it.

| Step | What it establishes | What it needs |
|---|---|---|
| [1. Pin the key](#1-pin-the-key) | Which key you hold TWZRD to | A source you chose |
| [2. Reference verifier](#2-reference-verifier) | The fields hash to the leaf, and the pinned key signed the leaf | `twzrd-receipt-verifier` from npm |
| [3. Standard library only](#3-standard-library-only) | The pinned key signed the leaf, checked with no TWZRD code | Node 18 or later |
| [4. Log inclusion](#4-log-inclusion) | The leaf is in a tree head the pinned key signed | `twzrd-log-verifier` from npm (source in this repository) |
| [5. Settlement](#5-settlement) | The payer the receipt names paid USDC in the transaction the receipt names | Any Solana RPC |

## The receipt

| | |
|---|---|
| Route | `GET https://intel.twzrd.xyz/v1/intel/trust/GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs` |
| Price paid | 0.05 USDC (50000 base units), Solana mainnet, x402 `exact` |
| Subject (`preimage.agent_id`) | `GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs`, TWZRD's seller wallet |
| Payer (`preimage.payer`) | `64NsKhbNGZCEj6sgTtjzscfuXSZSEpD1GoBXbT45yv4J`, a test wallet TWZRD funds |
| Settlement transaction | `5Lb8pTStADxWTjKevYNQMtobMAZhkMjofH6y6JW9aeRh4YgHeHTMbDK8KQEnSY9iD9hAEfBCWcGpg2fFytrNrJwN` |
| Signed at (`preimage.timestamp_unix`) | 2026-11-14T03:42:07Z |
| Leaf | `0x4891c868b5631e3d7c47dbad201ba0c935cbba60e35e3208d24ad1cbb6b96b7c` |
| Key id | `twzrd-receipt-ed25519-v2` |
| Log position | leaf index 19, tree size 20, log `intel.twzrd.xyz/v6`, root `0xe5f733e2304dfa7b179c11dbff58ead0a8ea325a29dfac68e16c7d4524865096` |

Three files hold it as the server returned it (re-indented, no field changed):

- [`proofs/intel-receipt/receipt.json`](./proofs/intel-receipt/receipt.json): the `twzrd_receipt` object of the 200 response.
- [`proofs/intel-receipt/log-inclusion.json`](./proofs/intel-receipt/log-inclusion.json): the `log_inclusion` object of the same response.
- [`proofs/intel-receipt/payment-response.json`](./proofs/intel-receipt/payment-response.json): the decoded `PAYMENT-RESPONSE` header of the same response.

Run the commands below from a clone of this repository:

```bash
git clone https://github.com/twzrd-sol/twzrd-trust.git && cd twzrd-trust
KEY=Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS
R=docs/proofs/intel-receipt
```

The outputs shown were produced on 2026-11-14 with `twzrd-receipt-verifier` 1.4.4,
`twzrd-log-verifier` 0.5.1 and Node 24.22.1.

## 1. Pin the key

The receipt names a key in `signing_pubkey`. Do not verify against it: a forged receipt
names its forger's key. Take the key from a source you chose, before you look at the
receipt. The current receipt key, `twzrd-receipt-ed25519-v2`, is published through three
separate channels. All three are TWZRD's, so comparing them rules out one tampered
channel, not a dishonest issuer:

| Source | Where |
|---|---|
| This repository | [receipt-v6-spec.md](./receipt-v6-spec.md#published-issuer-keys), "Published Issuer Keys" |
| npm | `twzrd-receipt-verifier` exports it as `CURRENT_RECEIPT_PUBKEY` |
| The live service | `/v1/intel/pubkey`, `/health`, `/.well-known/x402`, `/.well-known/jwks.json` |

```bash
curl -fsS https://intel.twzrd.xyz/v1/intel/pubkey | jq -r .public_key
curl -fsS https://intel.twzrd.xyz/health | jq -r .receipt_signing.trusted_pubkey
curl -fsS https://intel.twzrd.xyz/.well-known/x402 | jq -r .receipt.signature.public_key
curl -fsS https://intel.twzrd.xyz/.well-known/jwks.json \
  | jq -r '.keys[] | select(.kid == "twzrd-receipt-ed25519-v2") | .x_base58'
```

Each prints `Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS`. The four live paths share one
origin, so count them as one source. After the key is pinned, nothing below asks TWZRD for it.

## 2. Reference verifier

```bash
npx -y twzrd-receipt-verifier@1.4.4 $R/receipt.json --pubkey $KEY
```

```text
mode             : AO-Receipt (trust-API)
trusted pubkey   : Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS  [source: --pubkey (out-of-band)]
leaf_valid       : true
signature_valid  : true
RESULT           : VALID (TWZRD-authored, untampered)
                   verified with the same library TWZRD uses internally (npm: twzrd-receipt-verifier)
BOUND     domain   covered by Ed25519 over the signed payload
BOUND     agent_id   covered by Ed25519 over the signed payload
BOUND     score   covered by Ed25519 over the signed payload
BOUND     confidence_bps   covered by Ed25519 over the signed payload
BOUND     timestamp_unix   covered by Ed25519 over the signed payload
BOUND     payer   covered by Ed25519 over the signed payload
BOUND     settlement_tx   covered by Ed25519 over the signed payload
BOUND     reputation_score   covered by Ed25519 over the signed payload
BOUND     reputation_confidence_bps   covered by Ed25519 over the signed payload
BOUND     reputation_score_version   covered by Ed25519 over the signed payload
BOUND     reputation_feature_window_start_unix   covered by Ed25519 over the signed payload
BOUND     reputation_data_quality   covered by Ed25519 over the signed payload
FRESHNESS recheck_after_unix   covered by the V7 leaf binding
FRESHNESS staleness_days   covered by the V7 leaf binding
FRESHNESS score_decay_model   covered by the V7 leaf binding
VERDICT   valid-signature
trusted_due      : false
trusted_allow    : false
freshness_bound  : false
```

`leaf_valid` means the fields in `preimage` hash to `leaf`. `signature_valid` means the
pinned key signed that leaf. The `BOUND` and `FRESHNESS` lines list the fields the leaf
covers; change one and the leaf no longer matches. The last three lines are constants in
this verifier version (it prints `false` for every receipt) and are not a result of the
check. Exit code 0 means valid, 1 means invalid.

With `--pubkey` the verifier makes no network call. Without it, the verifier fetches the key
from `https://intel.twzrd.xyz/.well-known/x402`, which trusts the server you are checking.

An edited copy fails. Change the score and run it again:

```bash
jq '.preimage.score = 99' $R/receipt.json > /tmp/edited-receipt.json
npx -y twzrd-receipt-verifier@1.4.4 /tmp/edited-receipt.json --pubkey $KEY; echo "exit $?"
```

The output begins:

```text
mode             : AO-Receipt (trust-API)
trusted pubkey   : Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS  [source: --pubkey (out-of-band)]
leaf_valid       : false
signature_valid  : false
  - leaf mismatch: preimage does not hash to receipt.leaf
  - signature not valid for the trusted receipt key set
RESULT           : INVALID
```

and the command exits 1.

The signature does not expire; how old a receipt may be is your policy. `--max-age SECONDS`
rejects a receipt whose signed `timestamp_unix` is older than that, for example
`--max-age 604800` for seven days.

## 3. Standard library only

[`proofs/examples/verify-receipt-signature.mjs`](./proofs/examples/verify-receipt-signature.mjs)
is a short Node script with no dependency. It decodes the key, the leaf and the
signature, and asks `node:crypto` whether the key signed the leaf.

```bash
node docs/proofs/examples/verify-receipt-signature.mjs $R/receipt.json $KEY
```

```text
pinned key : Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS
leaf       : 0x4891c868b5631e3d7c47dbad201ba0c935cbba60e35e3208d24ad1cbb6b96b7c
signature  : VALID (Ed25519 over the 32 leaf bytes)
```

This checks the signature and nothing else. It does not recompute the leaf from the fields,
so it still prints `VALID` for the edited copy from step 2: that edit changed a field, and
the leaf in the file is still the leaf the key signed. Step 2 is what ties the fields to the
leaf. Step 3 confirms, with no TWZRD code in the path, that the holder of the pinned key
signed this leaf.

## 4. Log inclusion

```bash
npx -y twzrd-log-verifier@0.5.1 inclusion \
  --proof $R/log-inclusion.json --receipt $R/receipt.json --pubkey $KEY
```

```text
leaf            : 0x4891c868b5631e3d7c47dbad201ba0c935cbba60e35e3208d24ad1cbb6b96b7c
log_id          : intel.twzrd.xyz/v6
tree_size       : 20
pinned          : Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS
sth signature : valid
inclusion       : valid
RESULT          : VALID (leaf is in the signed log)
```

The proof is checked for the leaf in `receipt.json`, against the tree head carried inside
the proof, and that head's signature is checked against the pinned key. A receipt that is
not in the head fails here even if step 2 passes.

This shows the receipt is in this one head. It does not show that the log never presented a
different head to someone else. For that, compare heads over time
(`twzrd-log-verifier monitor`) and check the on-chain anchors:
[transparency-log.md](./transparency-log.md), [twzrd-log-verifier](../twzrd-log-verifier/README.md).

## 5. Settlement

The leaf binds `payer` and `settlement_anchor`, the last 32 characters of the settlement
transaction's signature. So step 2 already established that TWZRD signed a statement naming
this payer and this transaction. This step asks a Solana RPC what that transaction did.

```bash
node docs/proofs/examples/check-settlement.mjs $R/receipt.json
```

```text
transaction : 5Lb8pTStADxWTjKevYNQMtobMAZhkMjofH6y6JW9aeRh4YgHeHTMbDK8KQEnSY9iD9hAEfBCWcGpg2fFytrNrJwN
slot        : 469181040
block time  : 2026-11-14T03:42:06.000Z
status      : success (finalized)
fee payer   : BFK9TLC3edb13K6v4YyH3DwPb5DSUpkWvb7XnqCL9b4F
USDC delta  : GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs +50000
USDC delta  : 64NsKhbNGZCEj6sgTtjzscfuXSZSEpD1GoBXbT45yv4J -50000
receipt     : payer 64NsKhbNGZCEj6sgTtjzscfuXSZSEpD1GoBXbT45yv4J, signed at 2026-11-14T03:42:07.000Z
anchor      : matches (settlement_anchor is the last 32 characters of settlement_tx)
RESULT      : MATCH (the receipt's payer paid USDC in the transaction the receipt names)
```

The payer's USDC went down by 50000 base units and the seller wallet's went up by the same
amount. The fee payer is the facilitator named in the route's 402 (`extra.feePayer`): it
pays the network fee, so the buyer needs USDC only. `payment-response.json` names the same
transaction and payer.

[`check-settlement.mjs`](./proofs/examples/check-settlement.mjs) makes one read-only
`getTransaction` call at finalized commitment. What it prints is what the RPC reports: pass
a second endpoint as the last argument to ask another one.

## What this shows, and what it does not

It shows:

- The holder of TWZRD's published receipt key signed this receipt, and no bound field has
  changed since.
- The receipt names a payer and a settlement transaction, and a Solana RPC reports that
  transaction as finalized, moving 0.05 USDC from that payer to TWZRD's seller wallet.
- The receipt's leaf is in a transparency-log head signed by the same key.

It does not show:

- That the score is right. A receipt proves who made a statement and that it was not edited.
  It does not prove the statement.
- Outside demand. The buyer here is a wallet TWZRD funds.
- That the receipt is fresh. Apply your own `--max-age`.
- That the log is consistent over time. See step 4.
- Anything, if the key comes from the receipt itself or from the server at verification time.
  See step 1.

## Your own receipt

After a paid `GET /v1/intel/trust/{pubkey}`, save the 200 body and split it:

```bash
jq .twzrd_receipt response.json > receipt.json
jq .log_inclusion response.json > log-inclusion.json
```

Then run steps 2 to 5 on those files. The service also offers a hosted check,
`POST https://intel.twzrd.xyz/v1/receipts/verify` with the receipt as the JSON body. It is a
convenience that trusts the server, and it applies a 24-hour age limit: an older receipt
comes back `ok: false` with `leaf_valid` and `signature_valid` still `true`.

## Checked in CI

[`scripts/verify-intel-receipt-doc.test.mjs`](../scripts/verify-intel-receipt-doc.test.mjs)
runs steps 2 to 4 on the committed files in CI, offline, with the key pinned in the test. It
also checks that edited copies fail, that the receipt scores TWZRD's own wallet, and that
this page quotes the receipt in `proofs/intel-receipt/`. Run it with
`npm run test:intel-receipt-doc` after a root `npm ci`.

Related: [receipt-v6-spec.md](./receipt-v6-spec.md) (leaf layout, V7 migration),
[security-assurance.md](./security-assurance.md) (properties and non-claims),
[transparency-log.md](./transparency-log.md) (the log).
