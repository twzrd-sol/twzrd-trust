# TWZRD

Pre-spend trust for agents that pay x402 sellers. Before an agent pays,
TWZRD answers one question from public evidence: should this payment go ahead?
The buyer-side gate turns that answer into a refusal before the wallet signs.
This repository is the public source for the hosted checks, the npm packages,
and the receipt and record formats.

Two ways in: [with code](#with-code-createbuyerfetch), `createBuyerFetch` from
`twzrd-x402-gate@0.22.0`; [without code](#without-code-one-free-preflight), one
free preflight on the URL you are about to pay. Terms used here (payTo,
readiness card, AutoGate, Path A and Path B, V7 receipt, bind-v1, resource
join) are defined in the [glossary](./SKILL.md#glossary).

- **What it does:** vets the seller **before** USDC leaves the wallet, caps and ledgers every spend, and binds each settled payment to the exact offer it paid for (**bind-v1**, verifiable from public chain data). Advisory preflight is free ($0). The paid `quickCheck` is **$0.001** USDC, paid by the buyer over x402 (seller wash risk, tier and score; no receipt). Separately, the gate can issue a portable [`twzrd.payment_decision.v1`](./docs/payment-decision-v1-spec.md) record from its own decision, signed locally with your own signer; TWZRD never holds a key.

Not a wallet. Not a payment network. The commerce walkthrough lives in [docs/COMMERCE-KIT.md](./docs/COMMERCE-KIT.md).

**Canonical skill (always refresh)** • https://intel.twzrd.xyz/skill.md (skill `twzrd-trust`; the live copy carries its version) · ClawHub skill `twzrd-trust`  
**Spend-control SDK (npm)** • [`twzrd-x402-gate@0.22.0`](https://www.npmjs.com/package/twzrd-x402-gate) + seat [`x402-solana@3.0.1`](https://www.npmjs.com/package/x402-solana)<br>
**Live MCP** • https://intel.twzrd.xyz/mcp (streamable HTTP; free tools for x402 seller and resource checks)  
**Agent contract** • https://intel.twzrd.xyz/llms.txt · https://intel.twzrd.xyz/.well-known/agent.json

## What ships

- **Hosted checks and the gate.** `https://intel.twzrd.xyz/mcp` and the REST routes below, `twzrd-x402-gate` on npm, the offline `twzrd-receipt-verifier`, and the receipt transparency log (one on-chain anchor per advanced tree head, hourly). A no-spend recorded run is at `/v1/intel/demo-gate`.
- **Networks.** Free checks score x402 sellers on Solana mainnet and Base mainnet (`eip155:8453`), and the gate runs the scored preflight on both. The paid `/quick` and `/trust` endpoints accept the buyer's payment on either chain and score a Solana seller wallet, so signed V7 receipts cover Solana sellers. Other EVM chains are recognized and not scored. The examples below use the Solana seat. The gate's [network table](./twzrd-x402-gate/README.md#networks-solana-mainnet-and-base-mainnet-scored) covers Base.
- **Listing evidence (read-only).** A separate endpoint serves TWZRD's signed product-listing evidence; see [Listing evidence](#listing-evidence-read-only-endpoint).
- **Out of scope.** Identity of a person, company, or agent. Checkout, purchase completion, or delivery. Permission to spend. See [What TWZRD does not claim](#how-the-pieces-fit).

## With code: `createBuyerFetch`

Guard an agent's paying fetch: a caller-supplied USDC cap, an explicit recipient
allowlist, mandatory free preflight, and a local decision record before signing.

```bash
npm install twzrd-x402-gate@0.22.0 @x402/core @x402/fetch
```

```js
import { createBuyerFetch } from "twzrd-x402-gate";

const guardedFetch = createBuyerFetch({
  client,                           // your configured official x402Client
  maxPricePerCall: "0.01",          // USDC per call (required)
  allowedRecipients: [sellerPayTo], // the 402's accepts[].payTo (required)
  hourlyBudgetCap: "1.00",
});

const response = await guardedFetch(resourceUrl);
```

A preflight block, a call over the cap, an unlisted recipient or a check outage
throws `BuyerFetchBlockedError` before your signer runs. The
[quickstart](./twzrd-x402-gate/QUICKSTART.md) runs a blocked payment with no
wallet first. The optional `expectedAmount` quote binding needs `twzrd-x402-gate@0.12.4` or later.

Already on an `x402Client`, PayAI `x402-solana`, PayKit, MPP or `@x402/mcp`?
Pick your seat from the gate's
[entry-point table](./twzrd-x402-gate/README.md#which-entry-point); each seat
keeps its own defaults ([defaults by entry point](./twzrd-x402-gate/README.md#defaults-by-entry-point)).

## Without code: one free preflight

Send the URL you are about to pay. No signup, no wallet, no key.

```bash
curl -sS -X POST https://intel.twzrd.xyz/v1/intel/preflight \
  -H 'content-type: application/json' \
  -d '{"resource_url":"https://api.oblique.markets/api/v1/paid/time","price_usdc":0.01}'
# Or by payTo, the accepts[].payTo in the seller's 402 (Solana base58 or Base 0x):
#   -d '{"seller_wallet":"GYyTRmt317JafPHXPnM54Fsvsma5GnS9wm6qGMqaykdS","price_usdc":0.01}'
```

Read `readiness_card.decision` (`allow`, `warn` or `block`) and its
`reason_codes`. A `resource_url` resolves only when the URL is in the resource
join (`GET /v1/intel/resources`). `readiness_card.seller_wallet: null` with
`null_reason: "unknown_subject"` means it did not resolve: send the 402's
`payTo` as `seller_wallet` instead. An unknown subject is not a clean seller.
Preflight is advice for your own policy; it refuses nothing until a gate sits
on the pay path.

## Start here, by what you came to do

| You want to | Do this |
|---|---|
| See a refusal with nothing installed | Run the [hosted no-spend check](#hosted-no-spend-check) below: one `curl`, no wallet, no key. |
| Put the gate on a paying agent | [With code](#with-code-createbuyerfetch) above, then [`twzrd-x402-gate/QUICKSTART.md`](./twzrd-x402-gate/QUICKSTART.md). |
| Check one seller before paying, without code | [Without code](#without-code-one-free-preflight) above. |
| Call the checks from an MCP client | Add `https://intel.twzrd.xyz/mcp`; the tool list is live (`tools/list`). Agent contract: [llms.txt](https://intel.twzrd.xyz/llms.txt). |
| Review the cryptography and the claims | [REVIEW.md](./REVIEW.md) (bind-v1, with mainnet ground truth), [docs/security-assurance.md](./docs/security-assurance.md), [docs/receipt-v6-spec.md](./docs/receipt-v6-spec.md), [docs/transparency-log.md](./docs/transparency-log.md), [SECURITY.md](./SECURITY.md). |
| Know which document is current | [docs/README.md](./docs/README.md): every document in this repository, labeled canonical, historical or internal, with the versions verified on the date shown. |
| Build or publish from this checkout | [AGENTS.md](./AGENTS.md): what is source and what is a published-artifact mirror, the one supported install, and the fork relationship with the upstream monorepo. |

## Versions

Registry `latest` as read on 2026-11-11; killswitch container pin also rechecked on that date. The tree column is what this checkout mirrors; a difference is a pending resync, not a second product.

| Package | Registry | This tree | Role |
|---|---|---|---|
| `twzrd-x402-gate` | npm **0.22.0** | 0.22.0 | Buyer-side gate SDK and CLIs; the one package with source here |
| `x402-solana` | npm 3.0.1 | peer | Compatible Solana client seat |
| `twzrd-receipt-verifier` | npm and PyPI 1.4.4 | floor `^1.4.0` | Offline V5/V6/V7 receipt verifier (separate repository) |
| `twzrd-mcp-server` / `twzrd-mcp` | npm 0.6.3 / PyPI 0.2.3 | 0.6.3 (`dist/` mirror) | Local spend-capped MCP client; prefer the hosted MCP |
| `@wzrd_sol/eliza-plugin` | npm 0.10.2 | 0.10.2 (`dist/` mirror; source in `eliza-plugin-source/`) | elizaOS actions |
| `@wzrd_sol/plugin-trustgate` | npm 0.3.12 | 0.3.12 (`dist/` mirror) | elizaOS and facilitator settle hook |
| `twzrd-preflight` | npm 0.5.1 | separate repository | OpenClaw wrapped-fetch adapter |
| `twzrd-agent-intel` | PyPI 0.5.13 | not in this repository | Server package behind the hosted checks |
| `twzrd-log-verifier` | npm 0.5.3 | 0.5.3 | Offline transparency-log verifier: `npx -y twzrd-log-verifier selftest`. 0.5.3 refuses a leaf that is not a string; 0.5.2 and later require a receipt checked beside an inclusion proof to name its own leaf; 0.5.1 and later do not follow redirects from the log. Upgrade from 0.4.0 or earlier: 0.5.0 verifies the anchor transaction bytes and the authority's signature locally, where 0.4.0 trusts the RPC's parsed response; 0.3.0 also reports a failing different-size consistency path as proven equivocation |
| `@twzrd1111/agent-killswitch` | npm **0.2.1**; `ghcr.io/twzrd-sol/agent-killswitch:0.2.1` | 0.2.1 | Local OpenAI-compatible proxy with token and dollar ceilings, a file kill switch and a JSONL spend ledger |

---

## Run one blocked payment locally

```bash
npm ci
npm run build
npm run buyer-demo --workspace=twzrd-x402-gate
```

This uses the real x402 client against an offline 402 fixture. It prints
`reason: price_cap_exceeded`, `signer_invocations: 0` and `usdc_spent: 0`, and
writes `.twzrd/demo-decisions.jsonl` locally. It makes no network request and
needs no wallet.

For an installed consumer, pack the gate and install the tarball with its
optional `@x402/core` and `@x402/fetch` peers; then run `npx twzrd-buyer-demo`.
See the [package README](./twzrd-x402-gate/README.md) for the install and live
client wiring. `/quick` and `/trust` stay optional seller-score products; the
wrapper buys neither and makes no fulfillment claim.

## Hosted no-spend check

Run this one-line command with **no wallet, no API key, and no configuration**:

```bash
curl -fsS https://intel.twzrd.xyz/v1/intel/demo-gate | jq '{verdict: (.steps[] | select(.name == "block_path") | .verdict), approved: (.steps[] | select(.name == "block_path") | .approved), signerInvocations: (.steps[] | select(.name == "block_path") | .signer_invocations), mode, ok}'
```

Without `jq`, run: `curl -fsS https://intel.twzrd.xyz/v1/intel/demo-gate`

Expected output:
```json
{
  "verdict": "block",
  "approved": false,
  "signerInvocations": 0,
  "mode": "no_spend",
  "ok": true
}
```

*Blocks happen before your signer is invoked (`signerInvocations: 0`) — zero USDC at risk.*

---

## How the pieces fit

<!-- twzrd:ecosystem:begin (generated by scripts/render-ecosystem.mjs from docs/ecosystem.json; edit that file) -->
**Pre-spend trust for AI agents that pay x402 sellers: check the seller and resource before paying.**

| You are | Free | Paid |
|---|---|---|
| an agent about to pay an x402 seller | Readiness card (allow, warn or block), wash flags, seller reputation, offline receipt check. | $0.001 `quickCheck` (seller wash risk, tier and score, no receipt); optional $0.05 trust receipt, a signed V7 receipt when you pay on Solana. |

Each piece below works alone. Plugged into the hosted checks, they form one pre-spend path.

| Piece | On its own | Plugged in | Install |
|---|---|---|---|
| [Hosted checks](https://intel.twzrd.xyz/llms.txt) | Free checks with nothing to install: is this x402 seller safe to pay, by its payTo or by the resource URL. | The pieces below that screen a payment call it; it is where the decisions and the signed receipts come from. The receipt verifier needs no server. | Add `https://intel.twzrd.xyz/mcp` to an MCP client |
| [`twzrd-x402-gate`](https://www.npmjs.com/package/twzrd-x402-gate) | Wraps an x402 client's pay path: asks the hosted checks about the seller before your signer runs, refuses a block (the signer is never invoked), enforces a spend cap, and can issue a `twzrd.payment_decision.v1` record from its decision, signed with your own signer. | Decisions come from the hosted checks; pairs with `x402-solana` or `@x402/fetch` as the payer. | `npm install twzrd-x402-gate` |
| [`twzrd-preflight`](https://github.com/twzrd-sol/twzrd-preflight) | OpenClaw plugin: assign its wrapped fetch to the client and every 402 that passes through it is checked before a signer can attach payment (enforce and fail-closed by default). | Matches the gate's wrapper and adds OpenClaw tool-call gating, against the hosted checks. Payments outside the wrapped fetch (a ClawRouter proxy, unparsed exec or curl) are not covered. | `npm install twzrd-preflight` |
| [`twzrd-receipt-verifier`](https://github.com/twzrd-sol/twzrd-receipt-verifier) | Verifies a TWZRD receipt offline against a published Ed25519 key: no wallet, no API key, no trust in TWZRD's server. | Checks the signed receipts that the hosted checks issue. | `npx twzrd-receipt-verifier` or `pip install twzrd-receipt-verifier` |
| [`twzrd-mcp-server`](https://www.npmjs.com/package/twzrd-mcp-server) / [`twzrd-mcp`](https://pypi.org/project/twzrd-mcp/) | A local MCP client with 6 tools that pays the $0.001 and $0.05 calls itself under a spend cap (a wallet only if you enable paid calls). | Calls the hosted checks; use the hosted MCP directly for the free checks. | `npx -y twzrd-mcp-server` or `pip install twzrd-mcp` |
| [`@wzrd_sol/plugin-trustgate`](https://www.npmjs.com/package/@wzrd_sol/plugin-trustgate), [`@wzrd_sol/eliza-plugin`](https://www.npmjs.com/package/@wzrd_sol/eliza-plugin) | Framework seats: a settle hook for facilitators (see [docs](https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/facilitator-trust-in-3-lines.md)), a Faremeter payer chooser, and elizaOS actions. | Each seat calls the hosted checks from inside its framework. | `npm install @wzrd_sol/plugin-trustgate` |
| [`twzrd-agent-intel`](https://pypi.org/project/twzrd-agent-intel/) | The server package behind the hosted checks. Run it yourself behind a firewall; a local run serves a small static snapshot, not live data. | Point a self-hosted instance at live data with its environment variables. | `pip install twzrd-agent-intel`, then `twzrd-agent-intel-mcp` |
| Seller starters: [`x402-solana-starter`](https://github.com/twzrd-sol/x402-solana-starter), [`x402-seller-starter`](https://github.com/twzrd-sol/x402-seller-starter) | Cloudflare Worker templates for selling a paid API to agents over x402: `x402-solana-starter` is the production-style Solana storefront (x402 v2), `x402-seller-starter` a minimal wedge. | Both default to the TWZRD facilitator. `x402-solana-starter` also runs a settle guard, advisory and fail-open, that screens payers through the hosted checks. | Deploy button in each repo |

**Put them together**

- **Refuse before signing:** gate (or preflight) + hosted checks. A blocked seller never reaches your signer. Prove it with no wallet and no spend: `curl -fsS https://intel.twzrd.xyz/v1/intel/demo-gate`.
- **Keep proof of what you paid for:** paid trust receipt + receipt verifier. A signed receipt you or anyone else can verify offline.
- **Screen every settlement you broker:** plugin-trustgate settle hook + hosted checks. A facilitator aborts a settle to a blocked seller before the transfer.

**What TWZRD does not claim**

- TWZRD scores observed wallet and payment behavior. It does not prove a person, company, or agent identity.
- `authorizes_spend` is always false: a check is evidence for your own spend policy, never permission to spend.
- Not a wallet. Not a payment network.
<!-- twzrd:ecosystem:end -->

More: [docs/ECOSYSTEM.md](./docs/ECOSYSTEM.md).

---

## From this repo

This checkout is a public monorepo, not `npm install twzrd-x402-gate`. CI is
root `npm ci` then `npm run ci` (Node 20). Do **not** `npm ci` inside
`twzrd-x402-gate/` — gate typecheck needs sibling `twzrd-log-verifier` deps
from the root lockfile.

```bash
npm ci
npm run build
npm run typecheck
npm test --workspace=twzrd-x402-gate
npm run gate-eval-refuse --workspace=twzrd-x402-gate
```

`gate-eval-refuse` spends nothing and does not call the signer (`signer_invocation_count: 0`).
It needs egress to `https://intel.twzrd.xyz`. Artifact dirs (`eliza-plugin/`,
`plugin-trustgate/`, `twzrd-mcp-server/`) are `dist/` mirrors — do not try to
build or demo them locally. Hosted MCP: `https://intel.twzrd.xyz/mcp`.

---

## The pre-spend sequence

One order, whichever entry point you use. Free preflight advises; the gate on
the pay path enforces.

1. **Discover**: `GET /v1/intel/resources` (or `listDirectoryCallables`), the callable x402 URLs with their `payTo`. Bazaars list; TWZRD sits beside them.
2. **Cold-start (optional)**: `npx twzrd-cold-start` writes a default-deny `policy.json` from a pinned foreign 402 diet (0 USDC; not a TWZRD bazaar).
3. **Merchant card**: `GET /v1/intel/merchant_card/{pay_to}`. Refuse on `wash_flagged: true`; `null` means never evaluated, not clean.
4. **Preflight**: `POST /v1/intel/preflight` returns the readiness card (allow, warn or block). The curl is under [Without code](#without-code-one-free-preflight).
5. **Pay only when policy allows**: the gate refuses before signing, so a block shows `signerInvocations === 0`.
6. **Paid intel (Path A, optional)**: `GET /v1/intel/quick/{pay_to}` ($0.001, `quickCheck`: wash risk, tier and score, no receipt) or `/trust` ($0.05, a signed V7 receipt you verify offline with `twzrd-receipt-verifier`).
7. **Evidence**: the gate can issue a portable `twzrd.payment_decision.v1` record from its decision, signed by your own signer (`npx twzrd-payment-decision --verify`); `exportEvidenceBundle` / `npx twzrd-evidence-bundle` packages the run.

Refuse-first demo (0 USDC): `npx tsx twzrd-x402-gate/examples/commerce-kit.ts`  
Walkthrough: [docs/COMMERCE-KIT.md](./docs/COMMERCE-KIT.md)

---

## Listing evidence (read-only endpoint)

The product-listing check is not part of the pre-spend path above. TWZRD's
signed listing evidence is served read-only at `https://intel.twzrd.xyz/muse/mcp`
(`check_listing`, `get_claim`, `get_evidence`, `get_publication`,
`get_shopping_check`); no tool there places an order, opens a checkout or moves
money, and `authorizes_spend` is always `false`. One reference card exists
(Vuori Kore Short, Ink, US). It is an observer card, a capture of the store's
public pages, not a merchant attestation, and it carries an `expires_at`.

```bash
curl -sS https://intel.twzrd.xyz/muse/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_listing","arguments":{"product_url":"https://checkout.vuoriclothing.com/products/kore-short-ink","declared_unit_price":"79"}}}' \
  | sed -n 's/^data: //p' \
  | jq '.result.structuredContent | {result, reason, price_check, needs_approval, authorizes_spend}'
```

The reference card has lapsed, so today this returns `result: "expired"`
(`reason: "expired_claim"`, `needs_approval: true`). While a card is current, a
declared price above the advertised one returns `check_failed`
(`phantom_markup_detected`), a lower price or a card with no price sets
`needs_approval: true`, and a URL no card covers returns `unknown_seller`
(unknown is not clean).

**Check that the card is the one TWZRD published.** `get_publication` returns
the publication record as JSON in its `text` field: `verify_key` (base64),
`publication` (the digests and a base64 `signature`) and `signed_message` (how
the signed bytes are built). Base64-decode `verify_key` to its 32 raw bytes and
compare their sha256 with the fingerprint below. This README is the independent
pin: a fingerprint taken from the same response as the key proves nothing.
Never refresh this value from a live surface when re-syncing the mirrors;
change it only when the key is deliberately rotated. Then verify the Ed25519
`signature` over the signed bytes with that key, and check that the sha256 of
the `text` returned by `get_claim` and `get_evidence` equals
`publication.artifact_digest` and `publication.evidence_digest`. A valid
signature shows that TWZRD published these bytes; it is not a merchant
attestation.

```text
sha256:903d0d041e2d82fc0dd6f5252b4e904121e113e498d00b7385cad6061b4881af
```

---

## Packages & References

| Package | Pin | Description |
|---|---|---|
| `twzrd-x402-gate` | **@0.22.0** | Buyer-side gate SDK (`createBuyerFetch`) + pre-sign seat hooks |
| `x402-solana` | **@3.0.1** | Compatible Solana client seat for the pre-payment gate |
| `twzrd-receipt-verifier` | **@^1.4.0** | Standalone offline verifier for Ed25519 V7 receipts (V5 and V6 still verify) |
| `twzrd-mcp-server` | **@0.6.3** | Local spend-capped auto-pay client (6 tools); prefer hosted MCP |
| `@wzrd_sol/plugin-trustgate` | **@^0.3.12** | Eliza / facilitator adapter |

- **Document index (what is current, what is history):** [docs/README.md](./docs/README.md)
- **Commerce loop (don't sign blind):** [docs/COMMERCE-KIT.md](./docs/COMMERCE-KIT.md)
- **Step-by-step Guide:** [QUICKSTART.md](./QUICKSTART.md)
- **Concepts & Architecture:** [docs/taxonomy.md](./docs/taxonomy.md)
- **Receipt Specification (V7, with the V6 lineage):** [docs/receipt-v6-spec.md](./docs/receipt-v6-spec.md)
- **Receipt Transparency Log:** [docs/transparency-log.md](./docs/transparency-log.md) (`twzrd-log-verifier` on npm, source in this repository)
- **Receipt Verification & Ground Truth:** [REVIEW.md](./REVIEW.md)
- **Supported path and ownership:** [docs/SUPPORT_MATRIX.md](./docs/SUPPORT_MATRIX.md) · [docs/ACCESS_AND_RECOVERY.md](./docs/ACCESS_AND_RECOVERY.md)
- **Security Policy:** [SECURITY.md](./SECURITY.md) · [docs/security-assurance.md](./docs/security-assurance.md)

## Contributing and change control

Issues and pull requests on this repository. A sample that does not run exactly as shown is a bug. The release policy for `twzrd-x402-gate` is the manual `publish` workflow with an `expected_version` check and npm provenance; the published 0.22.0 carries a provenance attestation from this repository (`npm view twzrd-x402-gate@0.22.0 dist.attestations`). Earlier releases did not all follow that path; [AGENTS.md](./AGENTS.md) records the fork history. A change to what the gate allows or refuses ships in a minor release with a `CHANGELOG.md` entry ([policy](./twzrd-x402-gate/CHANGELOG.md#versioning-policy-from-0110)). Artifact directories are resynced from the published tarball, never hand-edited ([AGENTS.md](./AGENTS.md)). Tests pin the documentation: the current install pin, the pay-path contract, the refusal-code tables and the generated ecosystem block are all asserted by `npm test`, so a doc that drifts from the code fails CI.

## License

MIT. See [LICENSE](./LICENSE). The hosted checks run on infrastructure TWZRD operates; the server package behind them is published separately as [`twzrd-agent-intel`](https://pypi.org/project/twzrd-agent-intel/) on PyPI, also MIT.
