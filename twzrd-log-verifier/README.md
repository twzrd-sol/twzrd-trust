# twzrd-log-verifier

Offline verifier for the **TWZRD Receipt Transparency log** — the append-only,
Solana-anchored Merkle log of issued V6 trust receipts. Spec:
[`docs/transparency-log.md`](../docs/transparency-log.md).

Verifies, with **no trust in TWZRD's servers or code**, that:

- a receipt leaf is included in a signed tree head (**inclusion proof**);
- a newer tree head only appended to an older one (**consistency proof**);
- a tree head was **anchored on Solana** by the published anchor authority;
- two contradictory signed tree heads are a portable **misbehavior proof**
  (**equivocation detection**).

Full source ships in this repo and in the npm tarball. Crypto comes from the
same audited libraries as
[`twzrd-receipt-verifier`](https://github.com/twzrd-sol/twzrd-receipt-verifier)
(`tweetnacl` = ref Ed25519, `js-sha3` = Keccak, `bs58`); the RFC 6962/9162
Merkle algorithms and the TWZRD byte layouts are the only logic here.

## Why this exists

A valid V6 receipt proves TWZRD authored it. It does not stop TWZRD from
answering differently to different buyers (equivocation) or issuing receipts
after the fact (backdating). The transparency log makes both **provable**: every
receipt leaf is appended to one Merkle tree, heads are signed and anchored on
Solana, and any relying party can hold the log to its own history.

## Usage

```bash
npx -y twzrd-log-verifier selftest   # prove the checker checks (no files, no network)

# Is my paid receipt in the log the current signed head commits to?
npx -y twzrd-log-verifier inclusion --receipt receipt.json --proof proof.json --sth sth.json

# Did the log only append between two heads I saw at different times?
npx -y twzrd-log-verifier consistency --old sth-old.json --new sth-new.json --proof proof.json

# Was this head anchored on Solana by the published authority?
npx -y twzrd-log-verifier anchor --sth sth.json --tx <tx-signature> --authority <b58> [--rpc <url>]

# Do two heads contradict each other? (a positive result is publishable proof)
npx -y twzrd-log-verifier equivocation --a sth-a.json --b sth-b.json [--proof consistency.json]
```

Exit code 0 = the requested verification succeeded; 1 = it failed or errored.
Inclusion, consistency, and equivocation checks are fully offline. The anchor
check needs any Solana RPC endpoint — the RPC is a data source only and cannot
forge a signer or a memo binding.

The STH signing key defaults to the pinned built-in
(`9V6Pn19kiUA5Rn6JpQfNduanvGt2aXGwsarosNfa2Ldf`, the receipt issuer key, also
published at `intel.twzrd.xyz/.well-known/twzrd-receipt-pubkey`). Override with
`--pubkey` for out-of-band pinning.

## Library

```typescript
import {
  verifyInclusion, verifyConsistency, verifySth, verifyAnchor,
  checkEquivocation, merkleRoot, inclusionProof, consistencyProof,
  DEFAULT_STH_PUBKEY,
} from "twzrd-log-verifier";
```

Generation functions (`merkleRoot`, `inclusionProof`, `consistencyProof`,
`signSth`) are exported so proofs are reproducible from an entry list; relying
parties only need the `verify*` half.

## File shapes

```jsonc
// Signed Tree Head (GET /v1/log/sth)
{
  "domain": "TWZRD:RECEIPT_LOG_STH_V1",
  "log_id": "intel.twzrd.xyz/v6",
  "tree_size": 48213,
  "timestamp_unix": 1755072000,
  "root": "0x…64 hex…",
  "signature": "<base58 Ed25519>",
  "signing_pubkey": "<base58>"
}

// Inclusion proof (GET /v1/log/proof/inclusion?leaf=…)
{ "leaf_index": 17, "tree_size": 48213, "audit_path": ["0x…", "…"], "sth": { … } }

// Consistency proof (GET /v1/log/proof/consistency?old_size=…&new_size=…)
{ "path": ["0x…", "…"] }
```

## License

MIT
