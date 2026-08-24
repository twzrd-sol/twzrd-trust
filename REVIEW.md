# External review map — x402 resource binding (bind-v1)

This repo carries the complete client-side implementation of **bind-v1**:
binding an x402 payment on Solana to the exact 402 offer it settled, so a
third party can verify *what was paid for* from public chain data plus the
402 body (or its leaf fields) — the chain carries the leaf hash, the 402 is
its preimage — trusting neither the payer nor the gate.

Everything below is reviewable here or recomputable from mainnet. The one
server-side consumer (intel's verify endpoint) lives in a private repo, but
its behavior is fully exercisable live and free.

## Scope

- Commit range: `19e7869^..d5e5a4a` on `main` (8 commits, `19e7869` through
  `d5e5a4a` inclusive, all under `twzrd-x402-gate/`).
- Design note: leaf = sha256 over a domain-separated canonical-JSON record
  (`twzrd:x402-resource-binding:v1\n` + leaf). `body_hash` is always zero in
  v1 — offer bound, delivery not. No on-chain program: the leaf hash rides
  the settle transaction's SPL Memo instruction as `rb1:<base64url(32B)>`.

## Review dimensions

| Dimension | Where | What to attack |
|---|---|---|
| Canonicalization | `src/resource-bind.ts` | `canonicalJson` (sort/separators/null), `canonicalResourceUrl`, leaf field set; documented WHATWG-vs-simple-URL parity gaps |
| Threat model | `src/resource-bind-tx.ts` | memo replay vs TransferChecked-legs matching; "decodes presented bytes — caller must confirm the tx landed"; hard/soft/refuse honesty |
| Client seat | `src/x402-client-hook.ts` | stamp placement at `onBeforePaymentCreation`; raw-v1-402 cache (`wrapFetchRememberInvoice`) vs client-normalized CAIP requirements; seller `extra.memo` never overwritten |
| Compute economics | commit `4c3a832` | ExactSvm hardcodes 20k CU; Memo ≈ 1320 + 358·bytes ⇒ 48-byte memo cap; measured, margins documented in-code |
| Dialect interop | `93bacd4..d5e5a4a` | x402 v1 body (`network:"solana"`, per-accepts `resource`) vs v2 header (CAIP, envelope `resource.url`); the leaf hashes the **raw v1 body** representation |
| Test honesty | `test/resource-bind*.test.ts` + `test/fixtures/` | fixtures include a real settled wire tx and a real v1-dialect 402; hard paths execute end-to-end, not conditionally skipped |

## Ground truth (mainnet, verify yourselves)

Settled transactions whose memos carry bind leaves:

| tx signature | what it proves |
|---|---|
| `2BaW8jcPSmJPggj8Ky1Wqp3YXHEAghRoefVbU664szPhmebLVyPH5rU32ZhX65XnGC4Tu1bGdjqirWaoibqAghyF` | first compact-memo hard (house seller) |
| `3krnMvyq5j7HQJG8r2rPueRTdUvuAJJ1DWZiPvk19JHuhkuZMKYF5jsYuaQvdkR5ny2pA61DiWkHQm7xCJj4pr3n` | envelope-path hard after a seller-wallet rotation |
| `5Tq8sKFaPgakZDQ9YNRMWDEgriy8VLcVMearJMGSeQFtcSRrjUaeNDUh4nhYGkwbnWK7nUj52w6eeb4Asj88Zgn3` | cross-stack hard: different seller stack + facilitator, v1-dialect 402, raw-leaf memo |

Live surfaces:

- Verifier (free): `POST https://intel.twzrd.xyz/v1/intel/resource_bind/verify`
  with `{"signature": "...", "paymentRequired": <the 402 JSON>}` or
  `{"signature": "...", "leaf": {leaf_hash, pay_to, asset, amount_raw[, payer]}}`.
- A live v1-dialect 402: `GET https://reader.outbid.sh/scrape?url=https://example.com/`
  (the reader's own source lives outside this repo; the checks below don't need it)

## The strongest single check

Reimplement the leaf from this repo's spec alone, then:

1. `GET` the reader URL above; take the 402 JSON body.
2. Derive the leaf from its first solana-exact accepts entry + its `resource`.
3. Fetch tx `5Tq8sKFa…` from any mainnet RPC; confirm `meta.err == null`;
   decode the Memo instruction.
4. Your memo `rb1:<base64url(leaf)>` must equal the on-chain memo, and the
   TransferChecked legs must match ATA(pay_to, mint) / amount / mint.

If your independent implementation reaches `hard`, the spec survives
third-party reimplementation — which is the entire claim. If it does not,
that is a finding: open an issue.

## Known limitations (documented in-code, fair game to probe)

- v1 binds the offer, not the response body (`body_hash = 0`).
- `evaluateResourceBindFromSvmTx` proves memo inclusion only; legs matching
  requires the leaf fields (`evaluateResourceBindLegsFromSvmTx`).
- Decoding presented bytes ≠ the tx landed; callers confirm inclusion.
- URL canonicalization is simple (sorted query, no fragment), not full
  WHATWG normalization; adversarial URLs may diverge across languages.
- The 48-byte memo cap is measured against today's Memo program CU costs.

## Engagement

Issues and PRs on this repo. Findings that come with a failing reproduction
(a tx signature, a 402 JSON, an expected-vs-got leaf) get priority.
