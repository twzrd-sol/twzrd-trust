# twzrd-x402-gate

**Don't let your agent sign blind.** TWZRD is the spend-control SDK for agents paying over x402 — and the default
`onBeforePaymentCreation` policy engine for official x402 clients.

Commerce loop (directory → preflight → AutoGate → verify → evidence bundle):
repo [docs/COMMERCE-KIT.md](../docs/COMMERCE-KIT.md). `exportEvidenceBundle` /
`npx twzrd-evidence-bundle` writes `twzrd.evidence_bundle.v1`. This package is
not Catena's Agent Commerce Kit.

### One call (named export `twzrd`)

```js
import { twzrd } from "twzrd-x402-gate";

const result = await twzrd.safeFetch(url, {
  maxSpend: "0.10",              // per-call cap AND cumulative budget
  allowNetworks: ["solana", "base"],
  requireOfferBinding: true,     // compose → verify hard bind → only then pay()
  composeBoundTransaction,       // build unsigned bound bytes (no keys)
  pay,                           // sign/submit only after bind-v1 hard verify
});
// result.verdict: "allow" | "warn" | "block" — blocks have signerInvocations === 0
// result.receipt: { strength: "hard"|"soft"|"refuse", leaf_hash, fact_type: "resource_bound" }
```

`requireOfferBinding` is fail-closed: missing `composeBoundTransaction` returns
`bind_required_no_compose` with `signerInvocations === 0` (pay is never called).
The gate verifies the composed bytes, then calls `pay()` with that
`transactionBase64`. The old post-pay check remains as
`verifyOfferBindingAfterPay` only. This SDK never holds keys.

Full walkthrough: [QUICKSTART.md](https://github.com/twzrd-sol/twzrd-trust/blob/main/QUICKSTART.md) ·
verify receipts yourself: [REVIEW.md](https://github.com/twzrd-sol/twzrd-trust/blob/main/REVIEW.md)

**Core product (buyer gate):** after the client selects the exact payment requirement and
**before** payment payload creation / wallet signing — free preflight + merchant_card wash
refuse. Protects the **payer** from a risky **merchant** (`payTo`). Chain-neutral envelope;
**Solana-deep** reputation only (Base/EVM = explicit `unknown`).

### Default-on AutoGate (5 lines)

```bash
npm install twzrd-x402-gate @x402/core @x402/fetch @x402/svm
```

```typescript
import { x402Client } from "@x402/core/client";
import { installTwzrdAutoGate } from "twzrd-x402-gate";

const client = new x402Client();
// refuseWashFlagged defaults true; gateOnCanSpend stays false unless you opt in
installTwzrdAutoGate(client, { refuseWashFlagged: true });
// then register schemes + wrapFetchWithPayment as usual
```

**Intercept proof (0 USDC, wash seller never reaches signer):**

```bash
cd twzrd-x402-gate && npm run autogate-block-proof   # needs network: live intel preflight
# writes block-proof-<run_id>.json  (schema twzrd.autogate_block_proof.v1)
# public reason: TWZRD_TRUST_GATE_BLOCK: wash_flagged
```

`gateOnCanSpend` remains **opt-in** (`false` by default; set `true` or `TWZRD_GATE_ON_CAN_SPEND=1` only when you want hard cap enforcement).

**Optional (0.8.1):** a resource-server settle hook so merchants can apply **customer policy**
before they settle and serve (abuse, sanctions, bots, “don’t serve this payer”). Not an equal
mirror of the buyer problem — settled USDC is final; wash resistance is mainly TWZRD scoring.

## Seller settle guard (`onBeforeSettle`) — optional 0.8.1

Resource servers can screen the **payer** before *they* settle an inbound payment and serve
the resource. Use for merchant policy (abuse / sanctions / bots / customer selection). TWZRD is
not in the settlement path: advisory + fail-open by default. Attaches to official
`x402ResourceServer.onBeforeSettle` (inherited by `@x402/express|hono|next|fastify` and Python x402).

Do **not** treat this as “protect merchant reputation by rejecting USDC” — anyone can still
transfer on-chain. Wash/sybil edges are primarily discounted in TWZRD scoring, not forced
revenue refusal.

```bash
npm install twzrd-x402-gate@0.9.3
```

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { createTwzrdSettleGuard, twzrdPayerScreen } from "twzrd-x402-gate";

const server = new x402ResourceServer(facilitator);
server.onBeforeSettle(
  createTwzrdSettleGuard({ screen: twzrdPayerScreen() }),
);
```

**Defaults (fail-open / advisory):**

| Behavior | Default |
|----------|---------|
| Abort settlement | `decision=block` **or** `wash_flagged=true` |
| `warn` | **allowed** (continues) unless you set `abortOn.warn` |
| Default screen | free `GET /v1/intel/merchant_card/{payer}` via `twzrdPayerScreen()` |
| Screen/extract timeout | `timeoutMs: 3000` — on timeout, **continue** (fail-open) |
| Unresolved payer / null screen / screen error | **continue** unless `failOpen: false` |
| exact-SVM payload, no `@x402/svm` peer installed | reports `twzrd_svm_peer_missing` (warns once) and **continues** — without the peer, SVM payers are never screened; install it or set `failOpen: false` |
| Paid `/v1/intel/trust` | **not** default — inject a custom `screen` if you want it |

Payer identity prefers signed/encoded scheme fields (EIP-3009 `authorization.from`, Permit2
`permit2Authorization.from`, exact-SVM `payload.transaction` via optional peer `@x402/svm`)
over client-supplied loose aliases — so a spoofed `payload.payer` cannot bypass screening.

Offline demo: `npx tsx examples/seller-settle-guard.ts`  
Fixture-backed SVM extract tests live in `test/seller-hook.test.ts` +
`test/fixtures/exact-svm-transfer-checked.ts`.

**PayAI agentic-payments** (the active PayAI SDK, not the dormant x402-solana):
`npx tsx examples/payai-agentic-onPaymentVerified.ts` — wire `onPaymentVerified`
→ `toPayaiVerifyResult` to screen payers before serving. Fail-open by default.


## Demonstrable refuse mechanism (free, fail-open, reproducible)

**Status (2026-07-16):** mechanism proof — not adoption or demand.

Install the published gate and run against wash fixtures:

```bash
npm install twzrd-x402-gate@0.9.3
# from package root after install, or from a checkout:
npm run wash-dogfood
```

**Verified live (2026-07-16):**

| Fixture | preflight_id | decision | note |
|---------|--------------|----------|------|
| `7G73PL…` wash dogfood | 378468 | **block** | wash_flagged=true |
| `HuSiSpc…` | 378469 | **block** | wash_flagged=true, fleet≈98% |
| `BJGds…` alt wash | 378470 | warn | wash_flagged=true (nuance — not all wash is hard-block) |
| `4LkEF…` clean control | 378471 | warn | not wash |

Gate dogfood: `approved=false` `reason=twzrd_decision_block`, **USDC spent = 0**, **tx broadcast = none**, ALL PASS.

**Public transcript:** https://gist.github.com/twzrd-sol/2882bddee912f89e99061f3bc1da8227

**Accurate paste line:**

> Preflight returned decision=block on wash seller 7G73PL… / HuSiSpc… (preflight_id 378468 / 378469, wash_flagged=true). Gate approved=false reason=twzrd_decision_block. No USDC spent. No tx broadcast. Repro: `npm i twzrd-x402-gate@0.8.5 && npm run wash-dogfood` or gist above.

This is a **reproducible demonstration** that the free gate blocks known wash sellers with stamped `preflight_id`s and zero spend. It is **not** proof that external agents already default to this path at scale.

### Foreign-wallet block proof (official @x402 stack, fresh key, zero history)

**Verified 2026-07-23:** the same pre-sign block with a **brand-new wallet that has
zero TWZRD/corpus history** — proving the mechanism is wallet-independent, not a
whitelisted internal path.

- Wallet: `3GMuabSAATKEXTchSpyP1y5raBS7y6Kx8GShdAbiDLce` (generated fresh; corpus
  pre-check: `intel_score: 0`, `paid_calls: 0`, facilitator footprint `found: false`)
- Stack: official `@x402/core` client + `@x402/fetch` + `@x402/svm` `ExactSvmScheme`,
  TWZRD via `installTwzrdX402ClientHook` at `onBeforePaymentCreation`
- Result: `verdict: green_block` · `reason: twzrd_can_spend_false` ·
  `sign_after_abort: false` · `decision_count: 1` · `usdc_spent: 0` — payload
  creation aborted on a live mainnet 402 (`payTo GFpLvo…`, $0.001) before any signing

Repro with your own fresh key (no SOL/USDC needed — the block path never funds):

```bash
node --input-type=module -e "
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import { base58 } from '@scure/base';
const seed = randomBytes(32);
const s = await createKeyPairSignerFromPrivateKeyBytes(seed);
writeFileSync('fresh-wallet.json', JSON.stringify({ privateKey: base58.encode(seed), address: s.address }), { mode: 0o600 });
console.log(s.address);
"
SVM_KEYPAIR_PATH=./fresh-wallet.json npm run official-dogfood -- --block
```

Honest scope: run by the TWZRD team on TWZRD infra, so it is wallet-independence
proof, **not** an external adoption datapoint — that requires a non-internal
operator running this same command with their own attribution flags.


## Canonical integration (official x402 client)

```typescript
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { installTwzrdX402ClientHook } from "twzrd-x402-gate";

const client = new x402Client();
client.register("solana:*", new ExactSvmScheme(svmSigner));
// Optional: client.register("eip155:*", new ExactEvmScheme(evmSigner));

installTwzrdX402ClientHook(client, {
  gateOnCanSpend: false, // decision-only default (warn allowed)
  refuseWashFlagged: true,
});
// Strict opt-in: gateOnCanSpend: true — also block when can_spend=false
// → onBeforePaymentCreation: scores selectedRequirements, abort if policy denies

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
await fetchWithPayment("https://merchant.example/paid");
```

```text
official x402 client receives 402
  → selects exact requirement
  → onBeforePaymentCreation
  → TWZRD (network + payTo + amount + resource)
  → local policy allow | warn | block
  → agent-owned wallet signs same requirement
```

No AgentCash. No marketplace. No second probe. No TWZRD custody.

### PayKit (`@solana/pay-kit`)

Foundation [pay-kit#303](https://github.com/solana-foundation/pay-kit/pull/303)
exposes `onBeforeX402PaymentCreation` on `createPayKitClient` and registers it
on the internal x402Client. Pass TWZRD as that option — no TWZRD branding inside
pay-kit itself. This package does not hard-depend on unpublished `@solana/pay-kit`.

```typescript
import { createPayKitClient } from "@solana/pay-kit";
import { createTwzrdPayKitBeforePaymentHook } from "twzrd-x402-gate";

const client = await createPayKitClient({
  accept: ["x402"],
  onBeforeX402PaymentCreation: createTwzrdPayKitBeforePaymentHook({
    refuseWashFlagged: true,
  }),
  rpcUrl,
  signer,
});
```

Equivalent: `onBeforeX402PaymentCreation: installTwzrdAutoGate("pay-kit", { refuseWashFlagged: true })`.
Same official `@x402/core` context hook as Path E. Abort returns
`{ abort: true, reason }`; PayKit throws before `signTransactions`.

### MCP (`@x402/mcp`)

Wire `twzrdOnPaymentRequested` / prefer `onPaymentRequired` + `onBeforePayment` per
[lifecycle hooks](https://docs.x402.org/advanced-concepts/lifecycle-hooks). Same policy core.

### Raw-fetch composition (injectible pay client only)

```typescript
import { installTwzrdAutoGate } from "twzrd-x402-gate";
import { wrapFetchWithPayment } from "@x402/fetch";

// Guard RAW fetch, then hand to a client that still surfaces 402 to the guard layer
// — OR installTwzrdAutoGate(x402Client) (canonical) / installTwzrdX402ClientHook alias.
const payingFetch = installTwzrdAutoGate((guarded) =>
  wrapFetchWithPayment(guarded, client),
);
```

## Buyer flow (trustless, fail-open) — locked sequence

Canonical path for every agent that spends USDC on Solana x402:

| Step | Call | Cost | What gates pay |
|------|------|------|----------------|
| 1 | `POST /v1/intel/preflight` | free | `decision=block` → refuse (`twzrd_decision_block`). Score floor / optional `can_spend` also deny. |
| 2 | `GET /v1/intel/merchant_card/{payTo}` | free | `wash_flagged: true` → refuse by default (`twzrd_wash_flagged`). **Only tightens** step 1. |
| 3 | Optional paid trust | $0.05 / $0.001 | On `warn` or high-value: `GET /v1/intel/trust/{payTo}` or `quickCheck`. Never required for the free refuse path. |
| 4 | Pay (or refuse) | resource price | Only if steps 1–2 approved (and any opt-in paid escalate did not block). |

**Fail-open (no invent):**
- Preflight HTTP/network error → default fail-closed in gate 0.2+ (`TWZRD_FAIL_OPEN=true` restores legacy allow-on-outage).
- Merchant card unreachable / non-2xx / missing `wash_flagged` → `washFlagged=null` → **do not refuse on wash** (preflight decision stands).
- Only a successful card with `wash_flagged: true` triggers wash refuse or soft cap.

**Wash policy (exact):**
- Prior preflight deny → unchanged (wash never loosens a block).
- `refuseWashFlagged=false` or wash not true → keep preflight approval.
- `wash_flagged=true` + no cap → `approved=false`, `reason=twzrd_wash_flagged`, `verdict=block`.
- `wash_flagged=true` + `washMaxUsdc` set + `priceUsdc <= cap` → allow, `washCapped=true`, reason `twzrd_wash_capped_{price}_le_{cap}`.
- `wash_flagged=true` + price above cap (or price unknown) → refuse with `twzrd_wash_flagged_above_cap_*`.

**Order note:** `onWarnUpsell` (points at paid `/trust`) fires on preflight `warn` **before** the merchant_card wash check. A wash-flagged seller that preflighted as `warn` may still get the upsell hook, then be refused on step 2.

Dogfood (one public live proof path):
- Free only (wash refuse): `npm run wash-dogfood` → [`examples/wash-refuse-dogfood.ts`](./examples/wash-refuse-dogfood.ts)
- Official client + Path E hook (live Solana ≤$0.001): `npm run official-dogfood` → [`examples/official-x402-dogfood.ts`](./examples/official-x402-dogfood.ts). Needs `@x402/fetch` `@x402/svm` `@x402/core` `@solana/kit` `@scure/base` and a funded Solana key (`SVM_KEYPAIR_PATH` or `~/.agentcash/solana-wallet.json`). `--block` exercises hard `gateOnCanSpend` abort with $0 spend.
- Multi-hook composition (amount cap then TWZRD, abort short-circuit) is proven offline against the real `x402Client` in `test/x402-official-compat.test.ts`.
- Release identity: `CLIENT_VERSION` is read from `package.json` (single source of truth); `npm test` includes `version-identity`; `npm run pack-smoke` packs the tarball and checks the installed header.

## Install

```bash
npm install twzrd-x402-gate@0.9.3
```

Do not hardcode a version in this doc — every past pin here (**0.5.4**, **0.7.1**, **0.8.5**,
**0.8.6**) has gone stale. Check `npm view twzrd-x402-gate version` if in doubt.

Optional settle guard (resource-server **payer** policy): see **Seller settle guard
(`onBeforeSettle`) — optional 0.8.1** above. Do not confuse with facilitator
`createOnBeforeSettleHook` in `@wzrd_sol/plugin-trustgate/facilitator` — that screens
the **merchant/payTo** on a brokered settle (buyer-side counterparty check at the rail).

Live card screen: `npx tsx examples/seller-settle-guard.ts --live <payerWallet>`

## TWZRD Payment Control (protocol-neutral authorization core)

The gate now ships a protocol-neutral policy runtime underneath the x402 surface.
Defining invariant: **a signer path that calls `assertIntentApproved` will not sign
an intent that differs from what TWZRD evaluated.** (Honest scope: TWZRD does not
own third-party wallets - the binding is enforceable exactly where the check runs
before the signer, not as a claim over arbitrary wallet internals.)

```typescript
import {
  evaluateIntent,
  assertIntentApproved,
  createLocalDecisionSigner,
  createDecisionRegistry,
  x402RequirementsToIntent, // or ap2CheckoutToIntent
} from "twzrd-x402-gate";

const signer = createLocalDecisionSigner();
const registry = createDecisionRegistry(); // consume-once

const intent = x402RequirementsToIntent(selectedRequirements, { resourceUrl });
const token = await evaluateIntent(intent, {
  signer,
  mandate,                    // user/company mandate (purpose, ceilings, resource scope)
  policy,                     // local hard controls (caps, lists, recurring checks)
  intelligence: twzrdIntel,   // optional remote counterparty intelligence
});

// Wallet-side, immediately before signing the EXACT intent:
assertIntentApproved(intentBeingSigned, token, {
  registry,                       // replay / consume-once
  publicKeyPem: signer.publicKeyPem, // signature verification
});
// throws MISSING_VERIFIER_KEY | BAD_SIGNATURE | INTENT_HASH_MISMATCH |
//        DECISION_EXPIRED | DECISION_NOT_ALLOW | DECISION_REPLAYED
//        -> the signer is never invoked
// In-process matching without a key is unsafeAssertIntentApprovedWithoutSignature,
// exported only from the "twzrd-x402-gate/unsafe" subpath — never the root:
//   import { unsafeAssertIntentApprovedWithoutSignature } from "twzrd-x402-gate/unsafe";
```

- `PaymentIntent` v1 (frozen): protocol `x402 | ap2 | ucp | mpp | direct` +
  network/asset/amount/payTo + resource + facilitator + mandate + recurrence
  context, bound into one canonical `tiv1:` intent hash.
- Decisions are signed, expiring `DecisionToken`s - "policy version X approved
  this exact transaction at this timestamp", auditable offline.
- A **block is a signed decision**, not an exception - refusals audit the same
  way approvals do.
- Local hard controls (mandate scope, ceilings, allow/blocklists, cumulative
  caps, recurring price checks) never depend on API availability; remote
  intelligence (wash/fleet, counterparty score) plugs in via a provider.
- The category test lives in
  [`test/payment-control.test.ts`](./test/payment-control.test.ts): a mandate
  permits software under $100, a $12 checkout is approved, orchestration
  mutates `payTo` after approval, the wallet refuses on hash mismatch,
  `signerInvocationCount === 0`, and both the decision and the refusal verify
  from audit records alone.

### On the client hook (opt-in)

`installTwzrdAutoGate(client)` (or alias `installTwzrdX402ClientHook`) wires the runtime into the official
`onBeforePaymentCreation` seat. Pass `paymentControl` to build the canonical
intent, run the policy runtime (with the hook's own preflight fed in as remote
intelligence), and surface a signed, intent-bound `PaymentDecision`:

```typescript
import { installTwzrdX402ClientHook, createLocalDecisionSigner } from "twzrd-x402-gate";

const signer = createLocalDecisionSigner();
installTwzrdX402ClientHook(client, {
  paymentControl: {
    signer,
    mandate,                       // optional user/company mandate
    policy: { maxAmountUsd: "50" }, // optional local hard controls
  },
  onDecision: ({ intent, decision }) => handOff(intent, decision), // → assertIntentApproved
});
```

- **Tighten-only composition:** a `paymentControl` block aborts even when the
  legacy preflight allowed; it never loosens a legacy denial.
- **Opt-in:** with `paymentControl` unset the hook behaves exactly as before.
- x402 wire amounts (USDC micro units) are converted to the decimal USD the
  runtime expects by `x402RequirementsToIntent` (`decimals` defaults to 6;
  override via the intent context for other assets), so amount-based policies
  are not mis-scaled.
- Hook binding test:
  [`test/intent-binding.test.ts`](./test/intent-binding.test.ts).

### On MPP (Machine Payments Protocol) — Solana charge only

`createTwzrdMppOnChallenge` guards `Mppx.create({ onChallenge })`. The mppx
Solana method signs AND broadcasts the transaction inside `createCredential()`,
so `onChallenge` is the last deterministic checkpoint before money moves - and
mppx re-throws `onChallenge` errors, so a TWZRD block is an exception that means
**`createCredential()` never runs and nothing signs**. On allow, the guard
creates the credential for the exact challenge it evaluated; non-`solana/charge`
challenges fail closed (`allowUnevaluated: true` to opt out).

```typescript
import { Mppx } from "mppx/client";
import { client as solanaClient } from "mppx-solana";
import { createTwzrdMppOnChallenge, createLocalDecisionSigner } from "twzrd-x402-gate";

const mppx = Mppx.create({
  methods: [solanaClient({ signer: wallet })],
  onChallenge: createTwzrdMppOnChallenge({
    signer: createLocalDecisionSigner(),
    policy: { maxAmountUsd: "1.00" },
  }),
});
```

**Scope limit (honest):** the guard is authoritative only when no
`onChallengeReceived` event handler supplies a credential. mppx resolves
`eventCredential ?? onChallenge(...)`, so an event handler returning a credential
short-circuits the guard and pays ungated. Do not register both on one client.

**What it refuses, and why.** Each of these is a case where the transaction mppx
would actually sign is *not* the transaction the decision covers - so the guard
fails closed rather than approve a payment it cannot bind:

| Case | Code | Reason |
|---|---|---|
| Sponsored charge | `SPONSORED_CHARGE` | `sponsored` / `sponsorPath` / `feeTokenAmount` make mppx-solana build a **second transfer** to the sponsor on top of the advertised amount. PaymentIntent v1 binds one amount to one payTo, so approving it would authorize strictly more value than the decision covers. |
| Non-USD-pegged asset | `UNPRICED_ASSET` | Policy ceilings are USD; the wire amount is base-unit tokens. Pricing SOL would store `asset: solana:native` beside a **dollar** `amount` and lose the token quantity actually transferred. (A 1.5 SOL charge of `1500000000` at 9 decimals would otherwise evaluate as "$1.50" and sail under a $5 ceiling while moving ~$270.) USDC/USDT only until an intent version carries token amount + quote. |
| Unknown cluster | `UNKNOWN_CLUSTER` | mppx-solana's `resolveEndpoint` returns an unrecognized `cluster` **verbatim as the RPC endpoint URL**, and a network string containing "solana" is otherwise scored as mainnet - so `solana:https://seller-rpc.example` would inherit mainnet reputation for a chain never observed. Known cluster names only. |
| Misdeclared decimals | `MALFORMED_CHALLENGE` | A known stablecoin declaring the wrong decimals is a discount attempt, not a rounding error. |

The intent binds a **digest of the entire normalized challenge**, not just
`realm:id` - swapping `recipient` or `amount` under the same challenge id changes
the intent hash, so the decision no longer matches.

**Verdicts:** `block` throws. `warn` **proceeds to pay** by default - set
`treatWarnAsBlock: true` to refuse on warn too.

- `mppChallengeToIntent` binds the challenge id + realm into the intent
  (`resource.operation`), so the signed decision covers this exact challenge.
- Cluster names stay honest: `solana:devnet` classifies recognized-but-unscored.
- Proof: [`test/mpp-hook.test.ts`](./test/mpp-hook.test.ts) - block means
  credential count 0 and signer count 0.

### Experimental CLI: `twzrd-safe-fetch` (AgentCash advisory pre-check)

> **Not a challenge-bound firewall.** Classification: `advisory_precheck`.
>
> AgentCash CLI internalizes 402 handling. This tool can only decide whether to
> **invoke** AgentCash after scoring a **probe** challenge. AgentCash then makes a
> **second** request and may sign a different recipient/network/amount (TOCTOU).
> JSON output always sets `requirementScoredMatchesRequirementSigned: false`.
>
> Secure integrations: `installTwzrdAutoGate` over **raw** fetch + injectible pay
> client, or `twzrdOnPaymentRequested` (MCP). Do **not** wrap AgentCash's paying
> fetch with `withTwzrdGuard`.

```bash
# Advisory: block AgentCash invocation when can_spend=false
npx twzrd-safe-fetch https://example/paid --gate-on-can-spend --payment-network solana --json

# Dry-run: preflight only, zero USDC
npx twzrd-safe-fetch 'https://intel.twzrd.xyz/v1/intel/quick/BJGdsDXJFy63eCAnX3UmGfShp8BuqbtkTfcamyRGr7VQ' --dry-run --json
```

```text
probe request → TWZRD scores challenge A → (if allowed) AgentCash request → may sign challenge B
```

- Exit `2` = policy blocked (AgentCash never started).
- Exit `0` = passthrough / dry-run allowed / AgentCash returned success (binding unproven).
- Base/EVM: explicit `decision=unknown` (see Networks).

Library: `import { safeFetch } from "twzrd-x402-gate/safe-fetch"`.

## Quickstart: `installTwzrdAutoGate` (default-on)

Canonical entry point (design: `docs/strategy/install-autogate-design.md`). One name, five adapters:

| Call | Adapter |
|------|---------|
| `installTwzrdAutoGate(payWrap, opts?)` | Fetch: guard raw fetch → pay client |
| `installTwzrdAutoGate(x402Client, opts?)` | Official x402 `onBeforePaymentCreation` |
| `installTwzrdAutoGate("x402-solana", opts)` | PayAI `beforePayment` on `createX402Client` |
| `installTwzrdAutoGate("pay-kit", opts)` | PayKit `onBeforeX402PaymentCreation` (Foundation #303) |
| `installTwzrdAutoGate("mpp", opts)` | MPP `onChallenge` (returns handler) |

Aliases: `installTwzrdX402ClientHook`, `createTwzrdMppOnChallenge` remain; docs prefer AutoGate.
Kill switch: `TWZRD_GATE_ENABLED=false` or `TWZRD_AUTO_GATE=0`. Uninstall x402 installs with `uninstallTwzrdAutoGate(client)`.
The env switch is read **per call** on the x402-client, x402-solana, pay-kit and MPP seats, so flipping it moves an already-installed
gate in both directions. The **fetch / payWrap** seat is the exception: it resolves the switch once, when the fetch is composed,
so a fetch built while the switch was off stays ungated after you clear it — rebuild the fetch. `options.disabled: true` is a
permanent install-time opt-out everywhere and no env change revives it.


`installTwzrdAutoGate` is the one-liner form of "guard the raw fetch, then hand it to your
x402 client." It takes a `payWrap` function — whatever composes your paying client on top of
a fetch — and returns a fetch that's already gated: a blocked seller throws before your client
ever gets a chance to sign.

```typescript
import { installTwzrdAutoGate } from "twzrd-x402-gate";
import { wrapFetchWithPayment } from "@x402/fetch";

const payingFetch = installTwzrdAutoGate((guarded) => wrapFetchWithPayment(guarded, buyerWallet));

// Use payingFetch everywhere you'd call a paid resource:
const response = await payingFetch("https://api.exa.ai/search");
```

`payWrap` receives the **guarded** fetch (the guard has already run by the time your client
sees a 402) — this is the only correct composition order. Building it the other way round
(guarding an already-paying fetch) is a no-op; see [Compatibility note](#compatibility-note).
Any x402 client that composes over an underlying `fetch` works the same way — swap in
whatever `payWrap` your client's API expects (agentcash, ClawRouter, PayAI, a custom
`@x402/svm` scheme, etc.).

Default **ON**. Disable with `TWZRD_AUTO_GATE=0` (env, deploy-time kill switch) or
`{ disabled: true }` (per-call, e.g. in tests) — the raw fetch is handed straight to
`payWrap`, unguarded.

What happens on every HTTP 402 the raw fetch returns:
1. Reads the Solana-network entry from `accepts[]` (falls back to first entry) to get the seller wallet.
2. Calls `POST /v1/intel/preflight` — free, no auth. `decision=block` (or score floor) throws — `payWrap`'s client never signs.
3. Calls `GET /v1/intel/merchant_card/{payTo}` — free, no auth. `wash_flagged: true` refuses by default (only tightens step 2; fail-open if the card is unreachable — no invent).
4. Otherwise returns the 402 to `payWrap`'s client, which pays normally.

Non-402 responses pass through unchanged.

### Networks (Solana-deep, chain-neutral envelope)

The gate **recognizes** multi-chain 402s but only **reputation-scores Solana mainnet**.

| Network | Reputation scored? | Default policy (`unsupportedNetworkMode`) |
|---------|-------------------|-------------------------------------------|
| Solana mainnet | Yes — free preflight + merchant_card | allow/block from intel |
| Base / other EVM (`eip155:*`) | **No** | `observe` (default): `decision=unknown`, `policyAction=allow`, telemetry `unsupported_network_seen` |
| Base / EVM in `strict` mode | No | `policyAction=block` before sign |

This is intentional: Base listing abundance ≠ Solana behavioral history. Unsupported is never
represented as a TWZRD trust `allow`. Set `TWZRD_UNSUPPORTED_NETWORK_MODE=strict` (or
`{ unsupportedNetworkMode: "strict" }`) to hard-block unscored networks.

`requireReceipt` (Path A) follows the same line: `hard` receipts apply to **scored networks
only** — on an unscored network there is no receipt to buy, so the decision carries
`receiptSkipped: "unscored_network"` and continues. Use `strict` mode to fail closed there.

`requireLogInclusion` sits one step further: a captured Path A receipt does not **count** as
trust until its leaf is proven included in the Receipt Transparency log under a key you
pinned ([spec](../docs/transparency-log.md)). A valid signature proves authorship and
integrity; only the log proves the issuer showed everyone the same answer. The gate takes no
dependency on the log verifier — you wire it, and `verifyReceiptInLog`'s result fits the
verdict shape with no adapter:

```typescript
import { verifyReceiptInLog } from "twzrd-log-verifier"; // not yet on npm — see its README

await evaluate_x402_resource(url, requirements, {
  requireReceipt: true,
  x402Fetch,
  requireLogInclusion: {
    verifier: (receipt) =>
      verifyReceiptInLog({ baseUrl: "https://intel.twzrd.xyz", receipt, trusted: pinnedKeyDirectory }),
    // hard: true         — an unproven receipt denies spend (default)
    // onPending: "deny"  — a leaf not merged yet is unprovable at pay time; "allow"
    //                      tolerates the one-anchor-period merge window (default "deny")
    // refuseTofu: true   — never accept keys the log advertised about itself (default)
  },
});
```

The receipt is returned either way (`result.receipt`) — you paid for it. What changes is
`approved`: a denial sets `logInclusionDenied: true`, `policyAction: "block"`, and a reason of
`twzrd_log_inclusion_failed | _pending | _tofu_refused | _error`; `result.logInclusion` carries
the verdict (`key_id`, `leaf_index`, `tree_size`, `pending`, `tofu`). A verifier that throws
denies under `hard` — a broken or unreachable verifier must not wave receipts through. **Until
the live API serves `/v1/log/*`, every receipt reports `pending`**, so leave this off in
production or set `onPending: "allow"` knowingly.

Dual-chain accepts still prefer the Solana entry for scoring (same as payment clients that
prefer Solana when available).

### Lower-level: `withTwzrdGuard`

`installTwzrdAutoGate` is built on `withTwzrdGuard` — the fetch wrapper itself, if you want to
manage the raw/paying composition yourself:

```typescript
import { withTwzrdGuard } from "twzrd-x402-gate";
import { wrapFetchWithPayment } from "@x402/fetch";

const raw = globalThis.fetch;               // MUST still surface HTTP 402
const guarded = withTwzrdGuard(raw);        // guard sits upstream
const safeFetch = wrapFetchWithPayment(guarded, buyerWallet);

const response = await safeFetch("https://api.exa.ai/search");
```

What the guard does on HTTP 402:
1. Reads the Solana-network entry from `accepts[]` (falls back to first entry) to get the seller wallet.
2. Free `POST /v1/intel/preflight` — `decision=block` / score floor deny.
3. Free `GET /v1/intel/merchant_card/{payTo}` — `wash_flagged:true` **refuses by default**
   (`reason: twzrd_wash_flagged`). Fail-open if the card is unreachable (no invent).
4. If approved: returns the original 402 for the x402 client to pay.

Opt out of wash refuse: `withTwzrdGuard(fetch, { refuseWashFlagged: false })` or
`TWZRD_REFUSE_WASH_FLAGGED=0`. Soft cap instead of hard refuse: `washMaxUsdc` /
`TWZRD_WASH_MAX_USDC`.

Non-402 responses pass through unchanged.

### Auto-receipt on warn (revenue path)

```typescript
const safeFetch = withTwzrdGuard(x402Fetch, {
  autoReceipt: true,   // on warn or allow, auto-buy the $0.05 TWZRD trust receipt
  x402Fetch,           // the paying fetch — TWZRD earns the fee on-chain
  onReceipt: (receipt, tx) => {
    // receipt is a twzrd_receipt (V6 + ERC-8004 reputation_credential)
    console.log("Trust receipt captured:", tx);
  },
});
```

`autoReceipt` is **off by default** — it spends the **buyer's** USDC, so you opt in. When on,
every warn/allow verdict settles $0.05 USDC to TWZRD and returns a signed V6 trust credential
for the counterparty before you pay the resource.

**`x402Fetch` is yours to supply** (this package is dependency-free). Wire the proven
`@x402/svm` sponsored-feePayer client — the same one `twzrd-mcp-server` uses:

```typescript
import { wrapFetchWithPayment } from "@x402/fetch";
const x402Fetch = wrapFetchWithPayment(fetch, buyerWallet); // settles 402 challenges
```

Gate it behind your own ROI policy (e.g. only auto-buy the receipt for payments above a
threshold). Runnable, no-spend demo: [`examples/auto-receipt.ts`](./examples/auto-receipt.ts)
(`npm run autoreceipt-demo`). A bundled/sponsored `x402Fetch` (so integrators need no wallet)
is the next step.

### Quick tier ($0.001) — cheap paid qualify

The reputation ladder has three rungs: **free** preflight (`allow/warn/block`), **$0.001**
`quickCheck` (tier + score, no receipt), **$0.05** `autoReceipt` (full intel + signed V6
receipt). When the free preflight is inconclusive (`warn` / unknown seller) and you want a
cheap *paid* confirmation before committing — without paying 50× for the portable receipt —
use `quickCheck`:

```typescript
import { quickCheck } from "twzrd-x402-gate";

const q = await quickCheck(sellerWallet, { x402Fetch }); // settles $0.001 to /v1/intel/quick
if (q.available && (q.tier === "Gold" || q.tier === "Platinum")) {
  // tier is high enough — proceed with the larger payment
}
```

`quickCheck` is **fail-soft** — it never throws; any gap (no `x402Fetch`, unreachable, settle
failure) returns `available: false`, so a quick-tier hiccup can't break your flow. The hard
allow/warn/block decision stays the free preflight's job.

### Autonomous risk-escalation — `escalateOnWarn` (pay-to-confirm on warn)

The free preflight leaves an unknown/uncertain seller at `warn`, which **proceeds** by
default. `escalateOnWarn` closes the loop autonomously: on a proceeding `warn`, the guard
settles the cheap **$0.001** quick tier and **re-decides on the paid score** — below the
floor the payment is **blocked**, at/above it proceeds. The paid call fires from your
agent's own risk policy (no human), and the paid signal actually gates the spend (unlike
`autoReceipt`, which is upsell-only and never changes the decision).

```ts
const safeFetch = withTwzrdGuard(x402Fetch, {
  escalateOnWarn: {
    minSpendUsdc: 0.01,   // don't pay $0.001 to vet a sub-cent buy
    blockBelowScore: 40,  // block when the paid quick score is below this (default: preflightMinScore)
  },
  x402Fetch,              // settles the $0.001 quick charge
});
// warn + paid score < 40  -> throws "[twzrd-guard] payment blocked: twzrd_escalated_warn_block ..."
// warn + paid score >= 40 -> proceeds (result.escalated=true, result.escalatedScore set)
```

Opt-in, **fail-soft** (if the quick tier can't answer, the base `warn` is preserved), and it
**only tightens** — a `warn` may become a block, but an `allow` or `block` is never changed.
This is the autonomous demand loop: an uncertain counterparty is vetted with real paid intel,
automatically, before your agent commits.

### Sponsored payer — use the paid rungs with no wallet (prototype)

`createSponsoredX402Fetch` lets a **sponsor** settle the paid rungs on the agent's behalf, so
an integrator can call `quickCheck` / `autoReceipt` with **no wallet of their own**:

```typescript
import { createSponsoredX402Fetch, quickCheck } from "twzrd-x402-gate";

// `settle` = the funded backend (your @x402/svm fetch, or a TWZRD treasury sponsor endpoint).
const x402Fetch = createSponsoredX402Fetch({ settle });
const q = await quickCheck(seller, { x402Fetch }); // sponsor pays — caller holds no wallet
```

Two backends plug into `settle`: **gas-sponsored** (live via `@x402/svm` — agent pays USDC, the
resource server's `feePayer` covers SOL gas, the model `twzrd-mcp-server` uses) and
**full-sponsor** (a TWZRD treasury endpoint pays on the agent's behalf — the true no-wallet
path). The full-sponsor endpoint + treasury is **founder-gated** (who funds it + per-agent
budget caps); this ships the client seam + a dry-run so the wiring is ready.
No-spend demo: [`examples/sponsored-payer.ts`](./examples/sponsored-payer.ts) (`npm run sponsored-demo`).

## `evaluate_x402_resource` — standalone preflight

Use when you already have the `paymentRequirements` object from a parsed 402 body:

```typescript
import { evaluate_x402_resource } from "twzrd-x402-gate";

const result = await evaluate_x402_resource(
  "https://api.exa.ai/search",
  paymentRequirements, // X402PaymentRequirements from the 402 body
);

console.log(result.decision);    // "allow" | "warn" | "block"
console.log(result.trustScore);  // number | null
console.log(result.approved);    // boolean
console.log(result.receiptUrl);  // "https://intel.twzrd.xyz/v1/intel/trust/<payTo>"

if (!result.approved) throw new Error(`Blocked: ${result.reason}`);
```

With `autoReceipt`:

```typescript
const result = await evaluate_x402_resource(url, requirements, {
  autoReceipt: true,
  x402Fetch: myPayingFetch,
  onReceipt: (receipt, tx) => storeCredential(receipt),
});
// result.receipt — twzrd_receipt (V6 + ERC-8004 reputation_credential)
// result.receiptTx — on-chain settlement tx
// result.receiptFeeCaptured — true when fee landed
```

## Fee-payer preference (multi-facilitator `accepts[]`)

When a seller lists more than one facilitator in its 402 `accepts[]` (e.g. Dexter
*and* TWZRD), you can tell the gate which fee payer to settle through. It selects
the matching entry the seller **already offers** — it never adds, rewrites, or
forces an entry onto the seller's 402, and falls back to the normal
Solana-mainnet preference when nothing matches.

Opt-in, off by default. Set once via env:

```bash
# prefer TWZRD's facilitator when a seller multi-lists (alias resolves to its feePayer)
export TWZRD_PREFER_FEE_PAYER=twzrd
# or any explicit base58 fee payer you want to route to
export TWZRD_PREFER_FEE_PAYER=4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE
```

or programmatically:

```typescript
import { pickRequirements, TWZRD_FEE_PAYER } from "twzrd-x402-gate";

const chosen = pickRequirements(body.accepts, { preferFeePayer: TWZRD_FEE_PAYER });
```

With no preference set, selection is unchanged (first Solana-mainnet entry).

## Lower-level APIs

### Direct approval call

```typescript
import { createTwzrdGate } from "twzrd-x402-gate";

const gate = createTwzrdGate();
const { approved, reason, card } = await gate.approvePayment({
  payTo: "SELLER_WALLET_FROM_402",
  resourceUrl: "https://merchant.example/paid",
  priceUsdc: 0.003,
});
if (!approved) abort(reason);
```

### `@x402/mcp` payment hook

The hook accepts the real `@x402/mcp` v2 `PaymentRequestedContext`
(`{ toolName, arguments, paymentRequired }`) — wire it directly:

```typescript
import { createx402MCPClient } from "@x402/mcp";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { twzrdOnPaymentRequested } from "twzrd-x402-gate";

const client = createx402MCPClient({
  name: "my-agent",
  version: "1.0.0",
  schemes: [/* e.g. registered SVM scheme */],
  autoPayment: true,
  onPaymentRequested: (ctx) => twzrdOnPaymentRequested(ctx), // false = deny before signing
});
```

The legacy flat shape (`{ accepts, context }`) is still accepted. Prior to
0.6.1, only the flat shape was read — wired into the real `@x402/mcp` runtime
the hook saw `accepts: undefined` and fail-closed-blocked every payment (safe,
but a 100% false-block).

### `wrapFetchWithTwzrdGate`

```typescript
import { wrapFetchWithTwzrdGate, resolveConfig } from "twzrd-x402-gate";

// Alternative fetch wrapper — same interception logic, no autoReceipt.
const gatedFetch = wrapFetchWithTwzrdGate(fetch, resolveConfig());
```

`withTwzrdGuard` is preferred — it composes with `autoReceipt` and `onReceipt`.
`wrapFetchWithTwzrdGate` remains for codebases that can't migrate.

## Policy

A payment is **blocked** when:
1. `decision ∈ blockDecisions` (default: `["block"]`)
2. `trust_score < preflightMinScore` (default: `40`)
3. `can_spend === false` — **only** when `gateOnCanSpend: true` (default `false`, opt-in)

`warn` is allowed unless overridden. Preflight network failure **fails closed** by default (a preflight outage blocks the payment, so an intel hiccup never silently approves a spend); set `failOpen: true` / `TWZRD_FAIL_OPEN=true` to opt into legacy allow-on-outage.

A 402 whose payment requirements yield **no identifiable seller wallet** (missing/empty `payTo`, or an unparseable `accepts[]`) is a different case from "unknown seller" — it always **blocks** with `reason: twzrd_unidentifiable_payment_recipient`, without ever calling the preflight network. This is unconditional (not affected by `failOpen`): `failOpen` governs what happens when the TWZRD *service* is unreachable, not what happens when the caller can't say who they're paying.

> **`can_spend` note:** the free preflight returns `can_spend=false` for most sellers
> not yet in the TWZRD corpus, including legitimate ones. The default is decision-only
> gating so unknown sellers on platforms like Agentic.Market are not blocked by default.
> Set `gateOnCanSpend: true` for strict mode.

## Config

| Option | Env | Default | Description |
|---|---|---|---|
| `intelBase` | `TWZRD_INTEL_BASE` | `https://intel.twzrd.xyz` | Preflight API base |
| `preflightMinScore` | `TWZRD_PREFLIGHT_MIN_SCORE` | `40` | Block below this score |
| `blockDecisions` | `TWZRD_BLOCK_DECISIONS` | `block` | Decisions that throw |
| `failOpen` | `TWZRD_FAIL_OPEN` | `false` | `true` opts into legacy allow-on-outage; default blocks (fail-closed) |
| `gateOnCanSpend` | `TWZRD_GATE_ON_CAN_SPEND` | `false` | Also block when `can_spend=false` |
| `autoReceipt` | — | `false` | Auto-buy $0.05 TWZRD receipt on warn/allow |
| `x402Fetch` | — | — | x402-capable fetch for `autoReceipt` |
| `onReceipt` | — | — | Callback after receipt is captured |
| `disabled` (`installTwzrdAutoGate` only) | `TWZRD_AUTO_GATE=0`/`false` | `false` | Bypass the guard entirely — `payWrap` gets the raw, unguarded fetch |
| `attribution` | `TWZRD_ATTRIBUTION_INTEGRATION` + `TWZRD_ATTRIBUTION_RUN_ID` | — | Opt-in run attribution (see below) |

## Gate adoption proof (no-spend harness)

Deterministic install→transcript path for operators (no wallet, no USDC):

```bash
npm run adoption-proof -- --integration demo-autogate-proof --run-id 00000000-0000-4000-8000-000000000001
```

Emits `twzrd.gate_adoption_transcript.v1` JSON: block path aborts with `signerInvocations: 0`, allow path emits decision, attribution headers stamped on mocked preflight. Full acceptance criteria (what counts as `EXTERNAL_RUN` vs dogfood), and the
harness's own limits: [`docs/strategy/gate-adoption-operator-proof.md`](../docs/strategy/gate-adoption-operator-proof.md)
in this repo — the same path the transcript's `acceptanceDoc` field cites.

## Run attribution (optional, for integration correlation)

When you set `attribution`, the gate stamps **only the TWZRD preflight request** (never the
paid `/v1/intel/trust` call or the resource fetch) with correlation headers:

```
X-TWZRD-Integration: <integration>
X-TWZRD-Run-Id:      <runId>
X-TWZRD-Client:      twzrd-x402-gate/<version>
```

```ts
installTwzrdAutoGate((guarded) => wrapFetchWithPayment(guarded, wallet), {
  attribution: {
    integration: "payai-x402-solana-pr38",
    runId: crypto.randomUUID(), // echo this in your transcript / issue comment
  },
});
```

This is **correlation evidence, not proof of adoption** — the `runId` is caller-supplied and
spoofable. A run counts as an external execution only when the same `runId` (1) appears in the
integrator's own transcript, (2) is observed server-side with a real policy decision, and (3)
comes from non-internal lineage. No PII, secret, wallet, or payload is added; both fields must
be set or nothing is stamped.

## Compatibility note

**Proxied x402 clients** (AgentCash's `.fetch`, ClawRouter `:8402`): these clients handle
402 internally and return 200. The guard never sees a 402 if it wraps the client's *output* —
it must wrap the client's *input*. `installTwzrdAutoGate` enforces this composition order by
construction: it guards the raw fetch first, then hands the guarded fetch to your `payWrap`.
If you're composing `withTwzrdGuard` manually instead, pass the raw (non-paying) fetch to
`withTwzrdGuard`, then wrap its output in your x402 client — never the reverse. Or call
`evaluate_x402_resource` explicitly before routing through the proxy.

## Why pre-spend, not post-pay

`GET /v1/intel/trust/{wallet}` is the **paid** ($0.05 USDC) deep-intel surface — not a gate.
`POST /v1/intel/preflight` is the **free** `ReadinessCard` for the pre-spend decision.
The gate path only ever calls free endpoints — the preflight plus, by default
(`refuseWashFlagged: true`), the free merchant_card wash check. Paid intel
(`quickCheck`, `autoReceipt`) is otherwise opt-in, with one documented
exception (QUICKSTART 3b): on the fetch / payWrap seat, wiring a paying fetch
auto-enables buyer Path A, so a proceeding `warn` settles the $0.001 quick
tier ($0.05 at material size) through your wallet with no further flag —
opt out with `escalateOnWarn: false`, `requireReceipt: false`, or by leaving
`x402Fetch` unwired. The merchant-facing payment still waits on the free
preflight's verdict.

## License

MIT
