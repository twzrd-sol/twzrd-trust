# twzrd-log-verifier

Offline verifier for the **TWZRD Receipt Transparency log** — the append-only,
Solana-anchored Merkle log of issued trust receipts (V7 today; the first leaves are V6). Spec:
[`docs/transparency-log.md`](../docs/transparency-log.md).

Verifies, with **no trust in TWZRD's servers or code**, that:

- a receipt leaf is included in a signed tree head (**inclusion proof**);
- a newer tree head only appended to an older one (**consistency proof**);
- a tree head was **anchored by the published anchor authority** (the `anchor_head` program form the live log uses, or the memo form of the spec draft): the authority's signature and the head binding are checked from the transaction bytes; that the transaction is in the finalized chain, succeeded, and when, is as reported by the RPC you choose;
- heads stay verifiable **across key rotations**, via a pinned key directory;
- two signed tree heads at the same tree size with different roots are a portable
  **misbehavior proof** (**equivocation detection**) — including when different keys
  signed them. For heads of different sizes, a consistency proof that fails to verify
  is reported as consistency *unproven*, never as equivocation: the path is unsigned.

Full source ships in this repo and in the npm tarball. Crypto comes from the
same audited libraries as
[`twzrd-receipt-verifier`](https://github.com/twzrd-sol/twzrd-receipt-verifier)
(`tweetnacl` = ref Ed25519, `js-sha3` = Keccak, `bs58`); the RFC 6962/9162
Merkle algorithms and the TWZRD byte layouts are the only logic here.

## Why this exists

A valid V6 or V7 receipt proves TWZRD authored it. It does not stop TWZRD from
answering differently to different buyers (equivocation) or issuing receipts
after the fact (backdating). The transparency log makes both **provable**: every
receipt leaf is appended to one Merkle tree, heads are signed and anchored on
Solana, and any relying party can hold the log to its own history.

## Usage

On npm; 0.5.4 is the current version. It refuses a proof path entry that is not a
string and an `audit_path` that is not an array, and reports a leaf of `0` or `false`
as a type error wherever one is named (see "Changed in 0.5.4"). It is otherwise 0.5.3
(published 2026-11-14), which refuses a leaf that is not a string (see "Changed in
0.5.3"). That is otherwise 0.5.2 (published 2026-11-14), which requires a receipt
checked beside an inclusion proof to name its own leaf (see "Changed in 0.5.2"). That
is otherwise 0.5.1 (published 2026-11-13), which refuses redirects from the log
(below) and is otherwise 0.5.0 (published 2026-10-30). It fetches the
transaction bytes and verifies the transaction identity and the authority's signature
locally (see the anchor trust table below). Upgrade from earlier versions: 0.4.0's
anchor check still trusts the RPC's `jsonParsed` fields for the transaction's signers
and instructions, so a fabricated RPC response verifies as an anchor. 0.3.0 also
reports a consistency path that fails to verify between heads of different sizes as
proven equivocation; 0.4.0 fixed that verdict and reports it as consistency unproven
instead. Run it without installing:

```bash
npx -y twzrd-log-verifier selftest
```

or install it (`npm i -g twzrd-log-verifier`) and drop the `npx` prefix, as the
lines below do. To run the source in this repo instead:

```bash
npm --prefix twzrd-log-verifier install && npm --prefix twzrd-log-verifier run build
alias twzrd-log-verifier='node "$PWD/twzrd-log-verifier/dist/src/cli.js"'
```

```bash
twzrd-log-verifier selftest   # prove the checker checks (no files, no network)

# Is my paid receipt in the log the current signed head commits to?
twzrd-log-verifier inclusion --receipt receipt.json --proof proof.json --sth sth.json

# A paid response already carries its proof — verify it directly, no separate
# --leaf/--sth files (log_inclusion or the whole response as --proof):
twzrd-log-verifier inclusion --proof paid-response.json

# Did the log only append between two heads I saw at different times?
twzrd-log-verifier consistency --old sth-old.json --new sth-new.json --proof proof.json

# Did the published authority anchor this head? Reads the transaction bytes
# (use a mainnet tx_signature from /v1/log/anchors), checks they are that transaction
# and that the authority's signature verifies, matches an anchor_head instruction of the
# evidence-ledger program (--program overrides it; --ledger also pins the ledger account,
# anchor_ledger_pda) or an anchor memo, and requires the RPC to report it succeeded.
twzrd-log-verifier anchor --sth sth.json --tx <tx-signature> --authority <b58> [--program <id>] [--ledger <b58>] [--rpc <url>]

# Do two heads contradict each other? (a positive result is publishable proof)
twzrd-log-verifier equivocation --a sth-a.json --b sth-b.json [--proof consistency.json]

# Watch a live log: prove it only appended since the head you last pinned.
twzrd-log-verifier monitor --base-url https://intel.twzrd.xyz --state ./pin.json
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
checks are fully offline. The anchor check needs a Solana RPC endpoint, and the
verdict splits in two (`verified_locally` / `rpc_reported` in the result, printed
by the CLI):

| Fact | Established by |
|---|---|
| STH signature | the verifier, from the pinned key |
| the bytes are the transaction named by `--tx` | the verifier: first signature == `--tx` |
| the anchor authority signed it | the verifier: Ed25519 over the message bytes |
| the head binding (`anchor_head` fields or memo == STH) | the verifier, from the raw instruction data |
| the transaction is in the finalized chain | the RPC's word |
| it succeeded (`meta.err`) | the RPC's word |
| `slot`, `block_time` | the RPC's word |

So a malicious RPC cannot invent an anchor the authority never signed, but it
can hide one, report a failed or never-landed transaction as landed, or misstate
its time. The "existed no later than `block_time`" bound is only as good as the
RPC that reported it: use one you trust, or run the check against several and
compare. Anchor transactions use static account keys; a versioned transaction
that references an address-table account, or one whose message version is not
legacy or 0, is reported as an error, not a verdict.

### Changed in 0.5.4

- A proof path entry is a hex string. `verifyLogInclusion` refuses an `audit_path`
  entry of any other type (`audit path: audit_path[i] must be a hex string`), and
  `fetchConsistencyProof`, `verifyHeadsConsistent` and `checkEquivocation` refuse a
  consistency path entry the same way (`consistency path[i] must be a hex string`).
  In 0.5.3 and earlier an entry was read through `String()`, so an array holding the
  hash, or an object with its own `toString`, was read as that hash.
- `audit_path` itself is an array when it is present. A missing or `null` path is
  still the empty path (a one-leaf tree); `0`, `false`, `""` or any other non-array
  value was read as the empty path and is now
  `audit path: audit_path must be an array of hex strings`.
- A leaf that is named and is not a string is a type error everywhere, `0` and
  `false` included: `<where>: leaf must be a string of 64 hex chars`, with `<where>`
  one of `opts.leaf`, `twzrd_receipt.leaf`, `log_inclusion.leaf` or `leaf`. Only a
  missing, `null` or empty leaf names nothing.
  - `extractReceiptLeaf`, and so `verifyReceiptInLog` and CLI `inclusion --receipt`,
    read a wrapper's `leaf` of `0` or `false` as "no leaf here" and returned the
    nested `twzrd_receipt.leaf`. They now throw `leaf: leaf must be a string of 64
    hex chars`.
  - One message changes: in `verifyLogInclusion` and `extractReceiptLeaf`, a receipt
    leaf that is not a string was `receipt has no 64-hex-char .leaf field` and is now
    the type error. A receipt leaf that is missing, `null`, empty, too short or not
    hex keeps that message.
  - `verifyLogInclusion` reports every wrong-typed leaf in the document, in the
    order above, before the missing-leaf check and before any signature check.
- CLI: `inclusion`, `consistency` and `equivocation` exit 1 on a path entry that is
  not a string. `equivocation --proof` read entries through `String()` and reported
  such a path as verifying.
- Unchanged: hex in either case, with or without `0x`; a string that is not hex is
  still `invalid hex string`; STH fields are read as before.

### Changed in 0.5.3

- A leaf is a string wherever one is named: 64 hex characters, with or without `0x`,
  in either case. A value of any other type (an array, an object, a number, a
  boolean) is refused and is never converted. In 0.5.2 and earlier the value was read
  through `String()`, so an array holding the leaf, or an object with its own
  `toString`, verified as if it had named that leaf.
- `verifyLogInclusion`: a `twzrd_receipt.leaf` that is not a string is
  `receipt has no 64-hex-char .leaf field`; a block leaf or an `opts.leaf` that is not
  a string is `leaf must be a string of 64 hex chars`, prefixed with where it was
  found (`leaf`, `log_inclusion.leaf` or `opts.leaf`). Both are returned before any
  signature check.
- `extractReceiptLeaf` throws, and `verifyReceiptInLog` and `fetchInclusionProof`
  refuse before any request reaches the log.
- CLI: `inclusion --receipt FILE`, and `inclusion --proof FILE` on a whole paid
  response, exit 1.
- Unchanged: a bare `log_inclusion` block, a bare proof with `opts.leaf`, upper-case
  hex with or without `0x`, and a block whose leaf is missing, `null` or empty (it
  names nothing, so `opts.leaf` or the receipt names the leaf).
- One edge changes: a block leaf of `0` or `false` was read as "not named" and is now
  an error.
- Not in this release: `audit_path` entries are still read through `String()`. An
  entry that is not a string but prints as hex is accepted; the path still has to
  hash to the signed root.

### Changed in 0.5.2

- `verifyLogInclusion`, and `inclusion --proof FILE` on a whole paid response,
  require a `twzrd_receipt` in the document to name its own leaf: 64 hex characters,
  with or without `0x`, in either case. A receipt whose leaf is missing, empty, too
  short or not hex, or a `twzrd_receipt` that is not an object (null, a string, an
  array), is an error (`receipt has no 64-hex-char .leaf field`) returned before any
  signature check. In 0.5.1 and earlier the leaf of the attached `log_inclusion`
  block, or `opts.leaf`, stood in for it, so a proof for that leaf verified beside a
  receipt it says nothing about.
- Unchanged: a bare `log_inclusion` block, a bare proof with `opts.leaf`, and
  `verifyReceiptInLog`, which already applied this rule.
- Not in this release: the leaf value is still read through `String()`, so a value
  that is not a string but prints as 64 hex characters is accepted.

### Changed in 0.5.1

- The live-log helpers and the CLI no longer follow redirects (see Usage). A log
  that answers with a 3xx is an error, and nothing is fetched from its `Location`.
- A custom `fetchImpl` is called with `redirect: "manual"`, and a response it marks
  `redirected: true` is refused.

### Breaking for library users in 0.5.0

- `fetchAnchorTransaction` requests `encoding: "base64"` from the RPC and parses the
  bytes itself. A custom `fetchImpl` that answers with a `jsonParsed` transaction (or
  anything but `[base64, "base64"]`) is refused with an error, not accepted.
- `fetchAnchorTransaction` and `verifyAnchor` refuse a `txSignature` that is not base58
  of 64 bytes before any RPC call.
- `FetchedAnchorTx` gains `version` (`"legacy" | number`).
- `AnchorVerifyResult` gains `rpc_url`, `verified_locally` and `rpc_reported`.
- Errors from the fetch and parse step are prefixed `transaction:` instead of `fetch:`.
- CLI exit codes are unchanged: 0 = verified, 1 = failed or errored.

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

The live-log helpers and the CLI do not follow redirects. Every request goes to
the base URL you gave; a log that answers with a 3xx gets
`GET <url> -> HTTP <status>: redirect not followed` and nothing is fetched from
the `Location`. A custom `fetchImpl` is called with `redirect: "manual"`; a
response it marks `redirected: true` is refused as well. If your log moved, pass
its new base URL.

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
