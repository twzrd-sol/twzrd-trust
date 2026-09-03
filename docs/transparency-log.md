# TWZRD Receipt Transparency Log (TRT) — Spec v0.2

**Status:** Draft for implementation · **Applies to:** V6 trust receipts, AgentReadinessReceipt V1
**Verifier:** [`twzrd-log-verifier`](../twzrd-log-verifier/) (source in this repo)
**Last updated:** 2026-09-03

> **v0.2 changes (pre-genesis).** Heads now carry a `key_id` bound into the
> signature, and relying parties pin a **key directory** rather than a single
> key, so the log stays verifiable across key rotations — the 2026-09-02 receipt
> rotation showed this is an operational reality, not a hypothetical. No log has
> been served yet (`/v1/log/sth` is 404, `tree_size` would be 0), so this costs
> nothing and breaks no published head. The v0.1 domain remains implemented and
> verifiable; it was never served. See [Key rotation](#key-rotation).

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
STH_DOMAIN_V2 = "TWZRD:RECEIPT_LOG_STH_V2"     (ascii, exact)

preimage = STH_DOMAIN_V2
        || u16le(len(log_id_utf8)) || log_id_utf8
        || u16le(len(key_id_utf8)) || key_id_utf8
        || u64le(tree_size)
        || u64le(timestamp_unix)
        || root                                 (32 bytes)

signature = Ed25519.sign(preimage)              (over the preimage bytes directly)
```

JSON envelope (all verifier tooling consumes this shape):

```json
{
  "domain": "TWZRD:RECEIPT_LOG_STH_V2",
  "log_id": "intel.twzrd.xyz/v6",
  "key_id": "twzrd-log-ed25519-v1",
  "tree_size": 48213,
  "timestamp_unix": 1755072000,
  "root": "0x<64 hex chars>",
  "signature": "<base58 64-byte Ed25519 sig>",
  "signing_pubkey": "<base58 32-byte Ed25519 key>"
}
```

Rules:

- `log_id` is a stable identifier for one log (one entry ordering, one key
  lineage). A new receipt domain family or a re-genesis gets a **new** `log_id`,
  never a reset of an existing one.
- `tree_size` is monotone non-decreasing across STHs for a `log_id`.
- `key_id` names the key that signed this head and is **bound into the preimage**,
  so it cannot be relabelled after the fact. It resolves through the key directory
  below.
- `signing_pubkey` is advisory. A verifier checks the signature against the key it
  resolved from its own pinned directory; the envelope's copy must agree with that
  key, and never replaces it.
- The v0.1 domain `TWZRD:RECEIPT_LOG_STH_V1` had no `key_id` and was never served
  by any log. It stays verifiable against a single pinned key so anything built
  against the v0.1 package keeps working. Because a V1 preimage does not cover
  `key_id`, a V1 envelope that carries one is **rejected** rather than verified —
  the field would authenticate nothing.

## Key rotation

A transparency log outlives its keys. If verifiers pin only the *current* signing
key, then the moment that key rotates every previously signed head stops
verifying and becomes indistinguishable from a forgery — the audit trail is
destroyed exactly when someone needs to audit it. Worse, rotation would become an
escape hatch: *"that contradictory head was signed by a key we have since
retired."*

So relying parties pin a **key directory**, not a key:

```json
{
  "version": 1,
  "log_id": "intel.twzrd.xyz/v6",
  "keys": [
    {
      "key_id": "twzrd-log-ed25519-v1",
      "public_key": "<base58>",
      "mode": "verify-only",
      "not_before_unix": 1756000000,
      "not_after_unix": 1790000000
    },
    {
      "key_id": "twzrd-log-ed25519-v2",
      "public_key": "<base58>",
      "mode": "sign",
      "not_before_unix": 1790000000,
      "not_after_unix": null
    }
  ]
}
```

Rules, mirroring the `legacy_verification` model already used for receipt keys at
`/.well-known/twzrd-receipt-pubkey`:

- `mode: "sign"` may sign new heads; `mode: "verify-only"` is retired and must
  never sign again. **At most one key may be in `sign` mode.**
- Validity windows are `[not_before_unix, not_after_unix)`; `not_after_unix: null`
  is open-ended. **Windows must not overlap** — otherwise two keys could author
  heads for the same period and attribution is lost.
- A head verifies when its `key_id` resolves in the pinned directory *and* its
  `timestamp_unix` falls inside that key's window. So **retiring a key is not
  retroactive repudiation** — heads signed while it was active keep verifying
  forever — while a retired key still cannot be used to backdate or postdate a
  head into a window it never held.
- **Rotation does not launder equivocation.** Every key in the directory speaks
  for the same `log_id`, so two contradictory heads convict the log even when
  different `key_id`s signed them. "A different key of ours signed that one" is an
  admission, not a defence; the proof bundle records both `key_id`s.

Note that `timestamp_unix` is asserted by the log about itself, so window
enforcement bounds the *claimed* signing time. For a clock the log cannot choose,
pair it with a Solana anchor — the on-chain block time is the trustworthy bound.

Threshold signing (FROST) and an on-chain key registry are tracked separately;
both change only *where the pinned directory comes from*, not this format.

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
  "keys": [
    { "key_id": "twzrd-log-ed25519-v1", "public_key": "<base58>", "mode": "sign",
      "not_before_unix": 1756000000, "not_after_unix": null }
  ],
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

The descriptor is served by the log's own domain, so **the keys it advertises are
not a root of trust** — a compromised log would simply advertise the attacker's
keys. Relying parties pin the key directory and `anchor_authority` out-of-band
(they also ship as defaults in `twzrd-log-verifier`, the same pinning model the
cNFT verifier already uses).

`twzrd-log-verifier` enforces this structurally rather than by documentation: a
caller-supplied pin always wins over the descriptor, and a caller that pins
nothing must opt in explicitly with `trustDescriptorKeys: true` (CLI:
`--trust-descriptor`), which is reported in the output as trust-on-first-use. The
single-key `sth_pubkey` form is still accepted for v0.1-era descriptors.

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

0. **Key resolution** — resolve the head's `key_id` in the pinned key directory and
   require the head's `timestamp_unix` to fall inside that key's validity window.
   Every step below verifies signatures this way. Result: *this head is attributable
   to a key the log was entitled to sign with at the time it claims.*
1. **Inclusion** — given a receipt (or bare 32-byte leaf), an audit path, and an STH:
   recompute the root per RFC 6962 §2.1.1 from `LeafHash(leaf)`, `leaf_index`,
   `tree_size`; require it equals `sth.root`; require the audit path to target the
   same `tree_size` as the signed head it is checked against. Result: *this receipt
   is in the log that STH commits to.*
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
   proof between two valid STHs fails to verify, and regardless of whether the same
   `key_id` signed both.

Steps 0, 1, 2, and 4 are fully offline. Step 3 needs any Solana RPC endpoint (the
transaction data is self-authenticating given the pinned authority; the RPC is only a
data source and cannot forge a signer).

## Client policy

**STH pinning (implemented — `createSthPinStore`, CLI `monitor`).** An agent keeps
the newest head it has verified for a `log_id` and demands a consistency proof
every time the head moves. A log serving one history to one agent and another
history to a different agent cannot satisfy both, so the fork surfaces as soon as
the two heads meet — inside one agent over time, or between two agents comparing
pins (hand their two heads to the equivocation check directly). No coordinator is
involved.

Two behaviours are load-bearing and are enforced, not merely recommended:

- **The pin never advances on an unproven step.** A missing, unfetchable, or
  failing consistency proof leaves the old pin in place and reports an error.
  Advancing on faith would discard the very evidence the pin exists to hold.
- **A head smaller than the pin is not automatically an attack.** Load-balanced
  replicas lag. The correct response is to prove consistency in the other
  direction (observed → pinned) and keep the pin; only a failure there is a fork.
  Treating lag as an attack cries wolf, and ignoring it misses a real rollback.

**Gate integration (follow-up, not part of this spec).** `twzrd-x402-gate` can
then expose `requireLogInclusion: true` — treat a paid receipt as unverified until
`verifyReceiptInLog` checks out against a signed head. Note the merge-delay SLA
below: a receipt served before its leaf is merged is legitimately not yet
provable, which is a "retry after the next anchor" case, not misbehavior.

## Trust boundaries (unchanged by this spec)

The log proves *what was issued and when* — inclusion, append-only history, and
existence-by-time. It does **not** prove the scoring model is correct, that a seller is
safe, or that a score is fresh. Those remain the buyer's diligence (see
[security-assurance](./security-assurance.md)); model-commitment and attested-compute
work is tracked separately.
