# TWZRD — Lines-to-Leaves Merkle Bridge (LEAF-SPEC)

Status: scaffold, offline, zero spend. This document is normative for the
bridge in `src/merkle-bridge.ts`. It does not authorize anchoring, signing,
or any mainnet/devnet broadcast.

## 1. Purpose

Transform a local, hash-chain-verified `spend-ledger.jsonl` (written by
`@twzrd1111/agent-killswitch`, verified offline by its `verifyLedgerFile`)
into the RFC 6962-style Keccak-256 Merkle tree that the TWZRD evidence
ledger (`programs/evidence-ledger`) is built to anchor.

The bridge is the missing link between:

- **Local integrity** — the killswitch ledger's SHA-256 `prev` chain
  (raw-byte hash chain, verifier: `agent-killswitch verify-ledger`), and
- **Notarized integrity** — a Keccak-256 RFC 6962 tree whose root can be
  bound on-chain via `anchor_head` (see `PHASE-2.md`, Section 7, and
  `HERMES-REVIEW-CHECK.md` for the rent-cost findings on `anchor_head`).

## 2. Input contract (normative)

1. Input is the ledger's JSONL lines as raw bytes, in ledger order.
2. The caller MUST have run `verifyLedgerFile(path)` and MUST pass its
   chain report to the bridge. The bridge fails closed unless
   `report.ok === true` (see `assertChainIntact`). A `--strict` report is
   recommended but not required by the bridge.
3. **Entry bytes**: the exact bytes of the line, excluding a single
   trailing line terminator (`\n`, or `\r\n`). Nothing else is stripped:
   trailing spaces, unicode, key order — all part of the entry.
4. A blank line is an entry of zero bytes and gets a leaf.

## 3. Leaf hashing (normative)

```
LeafHash(e) = keccak256(0x00 || e)        e = entry_bytes
NodeHash(l, r) = keccak256(0x01 || l || r)   l, r: 32-byte node hashes
MTH({})   = keccak256("")                 keccak-256 of empty input
MTH([x])  = LeafHash(x)                   a single-leaf tree's root IS its leaf
MTH(D)    = NodeHash(MTH(D[0:k]), MTH(D[k:n]))
            where n = |D| and k is the largest power of two STRICTLY LESS than n
```

Prefixes `0x00` (leaf) and `0x01` (interior node) are the RFC 6962 domain
separation and prevent second-preimage ambiguity between leaf and node
hashes. Raw entry bytes are hashed directly; there is no length prefix and
no intermediate keccak of the line.

## 4. STH domain (TWZRD:RECEIPT_LOG_STH_V1)

`TWZRD:RECEIPT_LOG_STH_V1` is the domain-separation string for the **SIGNED
TREE HEAD preimage**, not for leaf or node hashing:

```
STH preimage = "TWZRD:RECEIPT_LOG_STH_V1" || tree_size (u64 LE) || root (32 bytes) ...
```

binding the tree size and the root under the domain, immediately preceded
on-chain by an Ed25519 precompile instruction checked against the
immutable `trusted_signer` (see `PHASE-2.md` §7 and the evidence-ledger
program in `wzrd-final@de9c0f6b`).

The bridge exports `STH_DOMAIN` so callers cannot typo or drift the domain,
and it computes neither the preimage nor the signature. Signing and anchor
submission are separate, explicitly authorized steps. Nothing in this module
or its tests touches a signing key or a cluster.

## 5. Determinism / idempotency (normative)

Given the same lines 1..N in the same order, on any machine, at any time:

- `leaves[i]` is a pure function of `lines[i]` (entry bytes only),
- `root` is a pure function of `leaves` (MTH split is deterministic), and
- no entropy, timestamps, environment or process state is consulted.

Submitting the identical 1..N sequence therefore yields the identical
`rootHex` and identical `leaves` every run. Any reordering, byte change, or
line-ending-convention change yields a different root (tested).

The bridge does not deduplicate lines; duplicates are entries like any
other (the underlying killswitch chain already prevents silent replay).

## 6. What this module explicitly does NOT do

- No transaction construction, signing, broadcasting or simulation.
- No Solana RPC. No keys. No `.pause`/kill-file interaction.
- No `anchor_head` rent analysis (~1.42M lamports per locked RootEntry;
  see `HERMES-REVIEW-CHECK.md`). No `init_ledger` sequencing.
- No STH construction or signature. No change to the killswitch ledger
  format or its SHA-256 `prev` chain.

## 7. Backend

`js-sha3` (the same backend as `twzrd-log-verifier`'s `src/merkle.ts`),
with a hard self-test on `keccak256("") == c5d2...470` at every bridge call.
SHA-3-256 (NIST padding) is a different function and must not be
substituted; the self-test aborts before producing leaves if the backend is
wrong.

## 8. Test vectors covered by `tests/merkle-bridge.test.ts`

- `keccak256("")` sentinel constant.
- Entry-byte extraction: LF, CRLF, bare, trailing spaces preserved, blank
  line = zero-byte entry.
- Leaf = `keccak256(0x00 || e)`; single-leaf root = its leaf.
- 2-leaf root = `nodeHash(l0, l1)`; 3-leaf splits k=2; 4-leaf = balanced
  two two-line subtrees.
- Determinism across 5 runs; order sensitivity; line-ending stability.
- Fail-closed chain report acceptance/rejection.

## 9. Follow-ons (each needs its own GO)

1. STH preimage construction + Ed25519 signer ceremony (offline first).
2. `simulateTransaction` run for `init_ledger` then `anchor_head` against a
   mainnet fork (0 fee), per `PHASE-2.md` §7 execution boundary.
3. Mainnet broadcast, only on a GO naming funding address (≤ 0.02 SOL),
   cluster and 10,000-lamport fee ceiling.
