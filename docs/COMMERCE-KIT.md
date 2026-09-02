# Don't let your agent sign blind

The TWZRD commerce loop is a walkthrough of `twzrd-x402-gate`, not a second
package and not Catena's Agent Commerce Kit (ACK-Pay). ACK-Pay remains the
optional receipt-passport shape on paid `/trust` and settle. The portable
artifact is the existing V6 receipt (or bind-v1). Do not invent another format.

```
directory → preflight → policy → pay or refuse → verify receipt → evidence bundle
```

TWZRD sits **beside** discovery. Bazaars list callables; the gate decides
whether to pay `pay_to`. Free preflight does **not** enforce. AutoGate on the
pay path enforces. Blocks have `signerInvocations === 0`.

This document is the product. Install remains `twzrd-x402-gate@0.9.3`.

## The six steps

### 1. Install the gate

```bash
npm install twzrd-x402-gate@0.9.3
```

Canonical seat — official x402 client:

```ts
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { installTwzrdAutoGate } from "twzrd-x402-gate";

const client = new x402Client();
installTwzrdAutoGate(client, { refuseWashFlagged: true });
const payingFetch = wrapFetchWithPayment(fetch, client);
```

Agents without a wallet — hosted MCP (streamable HTTP):

```json
{
  "mcpServers": {
    "twzrd-trust": {
      "url": "https://intel.twzrd.xyz/mcp"
    }
  }
}
```

That is the no-wallet seat. Do not wait for a Python SDK.

### 2. Point the agent at the directory

```ts
import { listDirectoryCallables, pickCallable } from "twzrd-x402-gate";

const listings = await listDirectoryCallables({ live402Only: true, limit: 10 });
const picked = pickCallable(listings);
// picked.resourceUrl + picked.payTo → preflight. No ranking.
```

Or curl:

```bash
curl -sS "https://intel.twzrd.xyz/v1/intel/resources?limit=10&live_402_only=true"
curl -sS "https://intel.twzrd.xyz/v1/intel/x402-directory?limit=10"
```

### 3. Preflight the seller

Free `POST /v1/intel/preflight` + `GET /v1/intel/merchant_card/{payTo}`.
`decision=block` or `wash_flagged: true` → do not sign.

### 4. Pay only when policy allows

`installTwzrdAutoGate` / `twzrd.safeFetch`. Caps and network allow-lists live
outside the model. A block never reaches the signer.

Lead with the refuse fixture (owned dogfood, not a brand judgment):

```bash
npx tsx examples/commerce-kit.ts
# or after install:
npx twzrd-gate-eval-refuse
```

Paid path is optional and tiny. `quickCheck` is $0.001 on `warn`. A V6 receipt
is $0.05 when you want a portable proof.

### 5. Verify the receipt afterward

After an allowed pay: bind-v1 via `POST /v1/intel/resource_bind/verify` or
independent recomputation ([REVIEW.md](../REVIEW.md)). V6 receipts verify
offline with `twzrd-receipt-verifier`. No second passport format.

### 6. Export an evidence bundle

```ts
import { exportEvidenceBundleFromAdoptionProof } from "twzrd-x402-gate";

const bundle = await exportEvidenceBundleFromAdoptionProof({
  integration: "acme-ops-agent-v1",
  runId: crypto.randomUUID(),
});
// schema: twzrd.evidence_bundle.v1
```

```bash
npx twzrd-evidence-bundle --integration acme-ops-agent-v1 --run-id "$(uuidgen)"
```

The bundle joins transcript + decision + optional bind/receipt + ledger
verdicts + refuse attestation. Secrets are stripped. A self-authored run is
**not** `EXTERNAL_RUN`. That still requires a foreign operator, a matching
server-side `X-TWZRD-Integration` / `X-TWZRD-Run-Id`, and the scrub in
`enrollment_funnel.md`.

## Pricing (document only)

| Check | Price | Role |
|---|---|---|
| Preflight + merchant_card | Free | Decide |
| bind-v1 / V6 verify | Free | Verify |
| `quickCheck` | $0.001 | Decide harder on `warn` |
| V6 receipt / ACK-Pay VC | $0.05 | Portable proof / learn |
| Settle guard payer screen | Free (advisory) | Deliver |

Merchant settle guard (`createTwzrdSettleGuard`) is the complementary page:
screen the payer before you deliver. It is not this walkthrough.

## What counts as done

A non-TWZRD operator runs this loop in their environment and publishes a
scrub-clean `twzrd.evidence_bundle.v1`. Internal dogfood, CI, house wallets,
and sponsored payers do not increment `path_b_artifacts_external`.

## Parking lot

Python gate SDK, team-policy console, dispute product, named sandbox,
marketplace ranking, new payment rails, a package named `agent-commerce-kit`.
