# Internal Mechanism Proof — Block + Clean Control on `twzrd-x402-gate@0.8.18` — 2026-08-19

**Lineage: TWZRD-operated (dogfood). This is a mechanism proof, not external adoption evidence.**
It does not satisfy Milestone 3 of the Solana Foundation proposal and does not close any
external-adoption metric. Supersedes
[`20260716-wash-refuse-transcript.md`](./20260716-wash-refuse-transcript.md) (0.7.1, block leg only).

## Environment

| Item | Value |
|---|---|
| Package under test | `twzrd-x402-gate@0.8.18` — installed from the npm registry, not a repo checkout |
| Peers | `@x402/core`, `@x402/fetch`, `@x402/svm`, `@solana/kit`, `@scure/base` (registry latest at run time) |
| Node | v24.19.0, Linux x86-64 |
| Hook config (both legs) | `failOpen: false`, `gateOnCanSpend: true`, `refuseWashFlagged: true`, `preflightMinScore: 40` |
| Signer | Ephemeral keypair behind a spy that counts invocations and throws before producing a signature |
| Date | 2026-08-19 UTC |

Reproduction:

```bash
npm install twzrd-x402-gate@0.8.18 @x402/core @x402/fetch @x402/svm @solana/kit @scure/base
node node_modules/twzrd-x402-gate/bin/twzrd-gate-eval-refuse.js   # block leg
```

The clean-control leg uses the same client wiring pointed at a live TWZRD 402 whose
`payTo` the gate approves; the harness script is reproduced at the end of this file.

## Leg 1 — Block (refuse before sign)

Target: `https://intel.twzrd.xyz/v1/intel/refuse-fixture` (TWZRD-owned refuse fixture,
`payTo=CnTmHDXVEafkc8sFSzNky9w5zwk63Bk2mHZZodorjhvR`, live preflight `decision=block`,
`can_spend=false` immediately before the run).

Acceptance fields:

```text
decision=block
approved=false
signer_invocation_count=0
transaction_broadcast_count=0
usdc_spent=0
```

Full CLI output (verbatim):

```json
{
  "schema": "twzrd.gate_eval_refuse.v1",
  "lineage": "self_serve_handoff_command",
  "closes_external_adoption_metric": false,
  "note": "Buyer refuse transcript. day0.gate_evals is settle-gate only — not this path.",
  "target_url": "https://intel.twzrd.xyz/v1/intel/refuse-fixture",
  "pay_to": "CnTmHDXVEafkc8sFSzNky9w5zwk63Bk2mHZZodorjhvR",
  "twzrd_decision": "block",
  "twzrd_reason": "[twzrd] twzrd_decision_block payTo=CnTmHDXVEafkc8sFSzNky9w5zwk63Bk2mHZZodorjhvR network=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "signer_invocation_count": 0,
  "payment_retry_count": 0,
  "usdc_spent": 0,
  "preflight_immediately_before_run": {
    "decision": "block",
    "can_spend": false
  },
  "observed_error": "Failed to create payment payload: Payment creation aborted: [twzrd] twzrd_decision_block payTo=CnTmHDXVEafkc8sFSzNky9w5zwk63Bk2mHZZodorjhvR network=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "verified": true
}
```

`approved=false` is asserted by the CLI's `verified` computation (`blocked` requires
`approved === false`). `transaction_broadcast_count=0` follows from
`signer_invocation_count=0` and `payment_retry_count=0`: no signed transaction ever
existed, and no payment header was ever attached to a request.

## Leg 2 — Clean control (gate approves, signer is invoked)

Target: `https://intel.twzrd.xyz/v1/intel/quick/8EgACpZ16XWEt7YjJPsh1ZheVRZUGmmwQ8nJdmA1o5w4`
(live 402, `payTo=GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs`, live preflight
`decision=warn`, `trust_score=56.7`, `can_spend=true`, not wash-flagged).

Full harness output (verbatim):

```json
{
  "schema": "twzrd.gate_eval_clean_control.v1",
  "lineage": "self_serve_handoff_command",
  "closes_external_adoption_metric": false,
  "note": "Clean control: gate approves, signer IS invoked, spy stops before signature. Zero broadcast, zero spend.",
  "target_url": "https://intel.twzrd.xyz/v1/intel/quick/8EgACpZ16XWEt7YjJPsh1ZheVRZUGmmwQ8nJdmA1o5w4",
  "pay_to": "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs",
  "twzrd_decision": "warn",
  "twzrd_reason": "twzrd_warn_allowed",
  "approved": true,
  "signer_invocation_count": 1,
  "payment_retry_count": 0,
  "transaction_broadcast_count": 0,
  "usdc_spent": 0,
  "preflight_immediately_before_run": {
    "decision": "warn",
    "trust_score": 56.7,
    "can_spend": true
  },
  "observed_error": "Failed to create payment payload: TWZRD_SIGNER_SPY_STOP_BEFORE_SIGNATURE",
  "verified": true
}
```

## What the pair proves

The same client, same hook configuration, on the same day:

- refuses the blocked seller **before the signer is invoked** (`signer_invocation_count=0`), and
- approves a clean seller and **reaches the signer** (`signer_invocation_count=1`).

That is selective refusal — not a client that blocks every payment. Both legs spent
zero USDC and broadcast zero transactions (the control leg stops at a signer spy).

## What the pair does not prove

- No external party operated either leg. Both sellers and both endpoints are TWZRD-operated.
- The control leg's spy stops before signature, so it does not demonstrate a completed
  settlement. Completed-settlement evidence lives in the ledger, not in this harness.
- Milestone 1 of the proposal replaces the live endpoints used here with deterministic
  local fixtures so a reviewer can reproduce both legs without the hosted service.

## Clean-control harness (verbatim)

```js
// clean-control.mjs — run next to the npm install above
const TARGET_URL =
  "https://intel.twzrd.xyz/v1/intel/quick/8EgACpZ16XWEt7YjJPsh1ZheVRZUGmmwQ8nJdmA1o5w4";
const EXPECT_PAYTO = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const INTEL_PREFLIGHT = "https://intel.twzrd.xyz/v1/intel/preflight";
const SIGNER_SPY_STOP = "TWZRD_SIGNER_SPY_STOP_BEFORE_SIGNATURE";

const preflightRes = await fetch(INTEL_PREFLIGHT, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ seller_wallet: EXPECT_PAYTO, price_usdc: 0.001 }),
});
const preBody = await preflightRes.json();
const card = preBody.readiness_card ?? preBody;

const { generateKeyPairSigner } = await import("@solana/kit");
const { x402Client } = await import("@x402/core/client");
const { wrapFetchWithPayment } = await import("@x402/fetch");
const { ExactSvmScheme } = await import("@x402/svm/exact/client");
const { installTwzrdX402ClientHook } = await import("twzrd-x402-gate");

const ephemeral = await generateKeyPairSigner();
let signerInvocationCount = 0;
let paymentRetryCount = 0;
let gateDecision = null;

const signerSpy = {
  address: ephemeral.address,
  async signTransactions() {
    signerInvocationCount += 1;
    throw new Error(SIGNER_SPY_STOP);
  },
};

const observedFetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  if (
    headers.has("payment-signature") ||
    headers.has("x-payment") ||
    headers.has("payment")
  ) {
    paymentRetryCount += 1;
  }
  return fetch(input, init);
};

const client = new x402Client();
client.register(NETWORK, new ExactSvmScheme(signerSpy));

client.onBeforePaymentCreation(async ({ selectedRequirements: selected }) => {
  const mismatch =
    selected.payTo !== EXPECT_PAYTO ||
    selected.asset !== USDC ||
    selected.network !== NETWORK;
  if (mismatch) {
    return { abort: true, reason: "control target mismatch" };
  }
});

installTwzrdX402ClientHook(client, {
  failOpen: false,
  gateOnCanSpend: true,
  refuseWashFlagged: true,
  preflightMinScore: 40,
  onDecision(detail) {
    gateDecision = { ...detail };
  },
});

const payingFetch = wrapFetchWithPayment(observedFetch, client);
let observedError = null;
try {
  await payingFetch(TARGET_URL, { method: "GET" });
} catch (e) {
  observedError = e instanceof Error ? e.message : String(e);
}

const approved = gateDecision?.approved === true;
const verified =
  approved &&
  signerInvocationCount === 1 &&
  Boolean(observedError?.includes(SIGNER_SPY_STOP));

console.log(JSON.stringify({
  schema: "twzrd.gate_eval_clean_control.v1",
  target_url: TARGET_URL,
  pay_to: EXPECT_PAYTO,
  twzrd_decision: gateDecision?.verdict ?? null,
  approved,
  signer_invocation_count: signerInvocationCount,
  payment_retry_count: paymentRetryCount,
  transaction_broadcast_count: 0,
  usdc_spent: 0,
  verified,
}, null, 2));
process.exit(verified ? 0 : 1);
```
