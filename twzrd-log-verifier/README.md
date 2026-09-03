# twzrd-log-verifier

Offline verifier for the **TWZRD Receipt Transparency log** — the append-only,
Solana-anchored Merkle log of issued V6 trust receipts. Spec:
[`docs/transparency-log.md`](../docs/transparency-log.md).

Verifies, with **no trust in TWZRD's servers or code**, that:

- a receipt leaf is included in a signed tree head (**inclusion proof**);
- a newer tree head only appended to an older one (**consistency proof**);
- a tree head was **anchored on Solana** by the published anchor authority;
- heads stay verifiable **across key rotations**, via a pinned key directory;
- two contradictory signed tree heads are a portable **misbehavior proof**
  (**equivocation detection**) — including when different keys signed them.

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

# Watch a live log: prove it only appended since the head you last pinned.
npx -y twzrd-log-verifier monitor --base-url https://intel.twzrd.xyz --state ./pin.json
```

`monitor` is the split-view detector. It fetches the log's current head, demands
a consistency proof against the head you last pinned, and persists the new pin.
It reports one of `pinned` / `unchanged` / `advanced` / `lagging` /
`equivocation` / `error`, and **never advances the pin on an unproven step** — a
missing or failing proof leaves the old pin in place. A head *behind* your pin is
treated as replica lag and proven consistent in the other direction, not
misreported as an attack. Run it on a schedule; on `equivocation` it writes a
publishable proof bundle (`--proof-out`) and exits 2.

Exit code 0 = the requested verification succeeded; 1 = it failed or errored;
2 = `monitor` proved equivocation. Inclusion, consistency, and equivocation
checks are fully offline. The anchor check needs any Solana RPC endpoint — the
RPC is a data source only and cannot forge a signer or a memo binding.

## Pinning keys

Every command takes either form:

- `--pubkey KEY` — pin one base58 Ed25519 key.
- `--keys FILE` — pin a **key directory**, which is what you want once the log
  has rotated a signing key. Each head names the `key_id` that signed it, bound
  into the signature, and the directory says which key was entitled to sign
  when. Retiring a key does not invalidate the heads it already signed, and a
  retired key cannot be used to backdate a head into a window it never held.

The default is the built-in single key
(`Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS`, the current receipt issuer key,
also published at `intel.twzrd.xyz/.well-known/twzrd-receipt-pubkey`).

The log's own descriptor is **not** a root of trust — a compromised log would
advertise the attacker's keys. A pin you supply always wins over the descriptor;
to accept the log's self-advertised keys you must opt in with
`--trust-descriptor`, and the output labels that run as TOFU.

## Library

```typescript
import {
  // proofs
  verifyInclusion, verifyConsistency, verifySth, verifyAnchor, checkEquivocation,
  merkleRoot, inclusionProof, consistencyProof,
  // keys
  validateLogKeyDirectory, resolveLogKey, currentSigningKey,
  // live log
  fetchLogDescriptor, fetchSth, fetchInclusionProof, fetchConsistencyProof,
  verifyReceiptInLog, resolveTrust,
  // split-view detection
  createSthPinStore,
  DEFAULT_STH_PUBKEY,
} from "twzrd-log-verifier";

// Is this paid receipt actually in the log, under a head my pinned keys signed?
const res = await verifyReceiptInLog({
  baseUrl: "https://intel.twzrd.xyz",
  receipt,                 // or: leaf: "<64 hex>"
  trusted: myPinnedKeyDirectory,
});
// res.valid === true  =>  inclusion proven against a signed head
```

Generation functions (`merkleRoot`, `inclusionProof`, `consistencyProof`,
`signSth`) are exported so proofs are reproducible from an entry list; relying
parties only need the `verify*` half.

## File shapes

```jsonc
// Signed Tree Head (GET /v1/log/sth)
{
  "domain": "TWZRD:RECEIPT_LOG_STH_V2",
  "log_id": "intel.twzrd.xyz/v6",
  "key_id": "twzrd-log-ed25519-v1",
  "tree_size": 48213,
  "timestamp_unix": 1755072000,
  "root": "0x…64 hex…",
  "signature": "<base58 Ed25519>",
  "signing_pubkey": "<base58>"
}

// Key directory (--keys), also served inside the log descriptor
{
  "version": 1,
  "log_id": "intel.twzrd.xyz/v6",
  "keys": [
    { "key_id": "twzrd-log-ed25519-v1", "public_key": "<base58>",
      "mode": "sign", "not_before_unix": 1756000000, "not_after_unix": null }
  ]
}

// Inclusion proof (GET /v1/log/proof/inclusion?leaf=…)
{ "leaf_index": 17, "tree_size": 48213, "audit_path": ["0x…", "…"], "sth": { … } }

// Consistency proof (GET /v1/log/proof/consistency?old_size=…&new_size=…)
{ "path": ["0x…", "…"] }
```

## License

MIT
