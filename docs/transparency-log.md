# TWZRD Receipt Transparency Log (TRT) — Spec v0.1

**Status:** Draft for implementation · **Applies to:** V6 trust receipts, AgentReadinessReceipt V1
**Verifier:** [`twzrd-log-verifier`](../twzrd-log-verifier/) (source in this repo)
**Last updated:** 2026-08-13

## Why

A valid V6 receipt proves *authorship and integrity* of its signed fields. It does not
prevent **equivocation** — TWZRD issuing two conflicting signed receipts for the same
subject at the same time and showing different answers to different buyers — and it does
not prevent **backdating**. The transparency log closes both gaps:

- every issued receipt leaf is appended to an **append-only Merkle log**;
- the log root is periodically **signed** (Signed Tree Head, STH) and **anchored on
  Solana** in a memo transaction from a published anchor authority;
- any two STHs must be **consistency-provable**; two valid STHs for the same tree size
  with different roots are a **cryptographic proof of misbehavior** anyone can publish.

After this ships, "trust TWZRD's server" becomes "verify TWZRD's log": the server can
still be wrong, but it can no longer be *selectively* or *retroactively* wrong without
producing portable evidence against itself.

This is the public half of the design. The log server implementation lives in the
private monorepo; this document plus `twzrd-log-verifier` are the complete contract a
relying party needs — nothing in the verification path requires trusting TWZRD code or
infrastructure.

## Log entries

An entry is the 32-byte receipt **leaf** exactly as it appears in the receipt JSON
(`receipt.leaf`, hex): the Keccak-256 digest over the packed preimage as computed by
[`twzrd-receipt-verifier`](https://github.com/twzrd-sol/twzrd-receipt-verifier)
(`recomputeLeaf` / `recomputeReadinessLeaf`). Both receipt families with keccak leaves
are eligible:

- `TWZRD:AO_REPUTATION_RECEIPT_V6` / `TWZRD:AO_ATTENTION_RECEIPT_V6`
- `TWZRD:AGENT_READINESS_RECEIPT_V1`

Entries are appended in issuance order. The log never removes or reorders entries.
Because the entry is already a domain-separated hash of the full preimage, the log
learns and reveals nothing beyond what the receipt holder chooses to disclose —
inclusion can be proven without publishing the receipt body.

## Tree

RFC 6962 Merkle tree structure with **Keccak-256** (same hash family as the receipt
leaves; `keccak256("")` self-test value
`c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`):

```
MTH({})            = keccak256("")                      (empty tree)
LeafHash(e)        = keccak256(0x00 || e)               (e = 32-byte receipt leaf)
NodeHash(l, r)     = keccak256(0x01 || l || r)
MTH(D[n])          = NodeHash(MTH(D[0:k]), MTH(D[k:n])) (k = largest power of 2 < n)
```

The `0x00`/`0x01` prefixes give second-preimage resistance (a leaf can never be
reinterpreted as an interior node). Inclusion and consistency proofs are exactly RFC
6962 §2.1.1 / §2.1.2 over this hash.

Maximum proof depth is **32** — deliberately equal to `MAX_PROOF_DEPTH` already
enforced by `twzrd-receipt-verifier` on the receipt `proof` field, which is where an
inclusion audit path travels when a receipt is delivered with one attached
(2³² entries ≈ 4.3 billion receipts of headroom).

## Signed Tree Head (STH)

The log key signs a fixed byte serialization (little-endian integers, matching the
receipt leaf encoding conventions):

```
STH_DOMAIN = "TWZRD:RECEIPT_LOG_STH_V1"        (ascii, exact)

preimage = STH_DOMAIN
        || u16le(len(log_id_utf8)) || log_id_utf8
        || u64le(tree_size)
        || u64le(timestamp_unix)
        || root                                 (32 bytes)

signature = Ed25519.sign(preimage)              (over the preimage bytes directly)
```

JSON envelope (all verifier tooling consumes this shape):

```json
{
  "domain": "TWZRD:RECEIPT_LOG_STH_V1",
  "log_id": "intel.twzrd.xyz/v6",
  "tree_size": 48213,
  "timestamp_unix": 1755072000,
  "root": "0x<64 hex chars>",
  "signature": "<base58 64-byte Ed25519 sig>",
  "signing_pubkey": "<base58 32-byte Ed25519 key>"
}
```

Rules:

- `log_id` is a stable identifier for one log (one entry ordering, one key). A new
  receipt domain family or a re-genesis gets a **new** `log_id`, never a reset of an
  existing one.
- `tree_size` is monotone non-decreasing across STHs for a `log_id`.
- v0.1 signs with the existing receipt issuer key
  (`Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS`, published at
  `/.well-known/twzrd-receipt-pubkey`). Key-registry work (rotation, on-chain key
  publication, threshold signing) is tracked separately and changes only *where the
  key comes from*, not this format.

## Solana anchor

On a fixed cadence (target: **hourly**, and at minimum once per 10,000 new entries),
the anchor authority publishes the current STH root in a Solana mainnet transaction
containing a single SPL Memo instruction:

```
twzrd-log-anchor:v1:<log_id>:<tree_size>:<root_hex_no_0x>
```

- Memo program: `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` (v2) — v1
  (`Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`) also accepted by verifiers.
- The **anchor authority** pubkey must be a signer of the transaction. It is published
  in the log descriptor (below) and is allowed to differ from the STH signing key
  (hot wallet vs. signing infra).
- An anchor is valid evidence only when the same `(log_id, tree_size, root)` also
  appears in a correctly signed STH — the memo binds the STH to Solana's clock and
  ordering; the STH signature binds it to the log operator.

Anchoring makes backdating detectable: a receipt whose inclusion proof lands under an
anchored root existed **no later than** that anchor's on-chain block time.

## Log descriptor (well-known)

Served at `https://intel.twzrd.xyz/.well-known/twzrd-log`:

```json
{
  "version": 1,
  "log_id": "intel.twzrd.xyz/v6",
  "sth_pubkey": "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS",
  "anchor_authority": "<base58 pubkey>",
  "anchor_memo_prefix": "twzrd-log-anchor:v1:",
  "anchor_cadence_seconds": 3600,
  "endpoints": {
    "sth": "/v1/log/sth",
    "inclusion": "/v1/log/proof/inclusion",
    "consistency": "/v1/log/proof/consistency",
    "anchors": "/v1/log/anchors"
  }
}
```

The descriptor is a convenience, not a root of trust — relying parties should pin
`sth_pubkey` and `anchor_authority` out-of-band (they also ship as defaults in
`twzrd-log-verifier`, the same pinning model the cNFT verifier already uses).

## HTTP API (implemented by the log server)

| Endpoint | Returns |
|---|---|
| `GET /v1/log/sth` | Current STH (JSON envelope above) |
| `GET /v1/log/proof/inclusion?leaf=<hex32>` | `{ leaf_index, tree_size, audit_path: ["0x..", ...], sth }` for the latest STH containing the leaf; 404 if not (yet) included |
| `GET /v1/log/proof/consistency?old_size=<n>&new_size=<m>` | `{ old_size, new_size, path: ["0x..", ...] }` |
| `GET /v1/log/anchors?limit=<n>` | Recent anchors: `[{ tree_size, root, tx_signature, slot, block_time }]` |

Paid receipt responses (`/v1/intel/trust`, `/v1/intel/merchant`) additionally attach,
once the leaf is merged: `log_inclusion: { log_id, leaf_index, tree_size, audit_path }`
— reusing the existing receipt `proof` slot semantics. A **merge delay SLA** of one
anchor period is allowed: a receipt may be served before its leaf is in the tree, and
the inclusion proof becomes fetchable by `receipt.leaf` afterward.

## Verification procedures (what `twzrd-log-verifier` implements)

1. **Inclusion** — given a receipt (or bare 32-byte leaf), an audit path, and an STH:
   recompute the root per RFC 6962 §2.1.1 from `LeafHash(leaf)`, `leaf_index`,
   `tree_size`; require it equals `sth.root`; require the STH signature verifies
   against the pinned log key. Result: *this receipt is in the log that STH commits to.*
2. **Consistency** — given two STHs and a consistency path: verify both signatures and
   RFC 6962 §2.1.2 from `old_size/old_root` to `new_size/new_root`. Result: *the log
   only appended between the two heads.*
3. **Anchor** — given an STH, a Solana tx signature, and an RPC endpoint: fetch the
   transaction, require a memo instruction whose payload parses to
   `(log_id, tree_size, root)` equal to the STH's, and require the pinned anchor
   authority among the transaction signers. Result: *this head existed at that slot.*
4. **Equivocation check** — given two STHs with valid signatures, the same `log_id`,
   and the same `tree_size` but different roots: emit a portable **misbehavior proof**
   (the two STH JSON envelopes are the entire proof). Also emitted when a consistency
   proof between two valid STHs fails to verify.

Steps 1, 2, and 4 are fully offline. Step 3 needs any Solana RPC endpoint (the
transaction data is self-authenticating given the pinned authority; the RPC is only a
data source and cannot forge a signer).

## Client policy (gate integration)

`twzrd-x402-gate` policy knobs this enables (follow-up work, not part of this spec):

- `requireLogInclusion: true` — treat a paid receipt as unverified until its inclusion
  proof checks out against a signed STH.
- **STH pinning / gossip**: agents keep the newest verified STH per `log_id` and demand
  a consistency proof whenever the head advances — split-view detection without any
  central coordinator. Two agents comparing pinned STHs can detect equivocation with
  zero server cooperation.

## Trust boundaries (unchanged by this spec)

The log proves *what was issued and when* — inclusion, append-only history, and
existence-by-time. It does **not** prove the scoring model is correct, that a seller is
safe, or that a score is fresh. Those remain the buyer's diligence (see
[security-assurance](./security-assurance.md)); model-commitment and attested-compute
work is tracked separately.
