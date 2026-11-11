# Spend-ledger Merkle bridge

Status: unpublished source, offline. Root `npm run ci` runs its tests
(`test:merkle-bridge`) and type-checks it (`typecheck:merkle-bridge`). It is
not part of any npm package. This document is normative for
[`index.ts`](./index.ts). It does not authorize signing, anchoring or any
transaction.

## What it does

`bridgeSpendLedger(ledgerBytes, { expectedHead? })` takes the bytes of an
`@twzrd1111/agent-killswitch` spend ledger (`spend-ledger.jsonl`), checks the
ledger's SHA-256 `prev` chain over those same bytes, and returns one Merkle
leaf per line and the root of the tree built over them. The tree is the
RFC 6962 Keccak-256 tree of [docs/transparency-log.md](../docs/transparency-log.md),
computed by `twzrd-log-verifier`'s `merkle.ts` (not a second copy).

The bridge does not accept a verification report from the caller. A report
names no bytes, so it cannot vouch for the lines it is passed with; the
bridge checks the chain itself, over exactly what it hashes.

## Input contract (normative)

1. The input is the whole ledger, read once, as bytes. Lines end in LF
   (`0x0a`).
2. Line bytes are exact: everything between two LFs. A CR before an LF is
   part of the line, as it is in the chain hash. The bridge never re-encodes.
3. Refused, with `LedgerNotBridgeable` naming the line:
   - bytes after the last LF (a torn or in-progress write);
   - an empty line (the chain skips it, so nothing binds it);
   - a line that is not valid UTF-8 JSON, or not a JSON object;
   - a line without its own `prev` (rows written before the chain existed,
     or by a copy that does not chain);
   - a `prev` that is not `"genesis"` on line 1, or not the lowercase hex
     SHA-256 of the previous line's exact bytes after that. This covers an
     edited, removed or reordered line and a fork (a row naming an earlier
     line than the one before it).
4. `expectedHead`, when given, must equal the SHA-256 hex of the last line
   (the `head` that `agent-killswitch verify-ledger --json` reports). The
   chain shows partial edits; only a head recorded earlier shows a ledger
   rewritten end to end with fresh `prev` values.

Anything the bridge accepts, `agent-killswitch verify-ledger --strict` also
accepts with the same line count and head (tested). The bridge is stricter:
`--strict` also passes legacy rows, empty lines and a torn tail, and the
bridge refuses all three. A ledger shared by several writers can fork; the
bridge refuses a forked ledger, as `--strict` does.

## Hashing (normative)

```
entry          = the exact line bytes (rule 2)
LeafHash(e)    = keccak256(0x00 || e)
NodeHash(l, r) = keccak256(0x01 || l || r)        l, r: 32 bytes
MTH({})        = keccak256("")
MTH(D[n])      = NodeHash(MTH(D[0:k]), MTH(D[k:n]))  k = largest power of two < n
```

The hash backend self-tests `keccak256("")` before every bridge call
(`c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`).
SHA3-256 is a different function and fails the self-test.

## Determinism

The same bytes always give the same leaves and root: no randomness, clock or
environment is read. Any change to a line's bytes, to their order, or to the
line endings changes the root, and every such change except a full rewrite
also breaks the chain and is refused.

## Not the receipt log

The receipt transparency log's entries are 32-byte receipt leaves, and its
signed heads bind a `log_id` (`intel.twzrd.xyz/v6` today). A spend-ledger tree
has different entries, so it is a different log: per the `log_id` rule in
[docs/transparency-log.md](../docs/transparency-log.md#signed-tree-head-sth),
signing or anchoring one needs a new `log_id`, never the receipt log's. The
bridge exports no STH domain and builds no head. Choosing the `log_id` and
the head format is part of that later, separate order.

## What it does not do

- No signed tree head, no signature, no key.
- No RPC, no transaction, no simulation, no anchor.
- No change to the killswitch ledger format or its chain.
