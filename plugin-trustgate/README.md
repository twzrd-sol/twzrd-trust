# @wzrd_sol/plugin-trustgate

Buyer-side **x402 trust gate** for elizaOS agents. Before your agent signs a payment to a seller, score that seller via the **free** TWZRD preflight (ReadinessCard: allow / warn / block) and refuse `block`-rated merchants. No auth, no cost, no Solana dependency in the gate; fail-closed by default.

## Marketplace alignment (honest scope)

TWZRD's full free buyer sequence on the marketplace is:

1. Free **preflight** ReadinessCard (this package implements this)
2. Free **merchant_card** `wash_flagged` refuse (default on the product stack)
3. Optional paid **V6 trust receipt** (~0.05 USDC)
4. Optional facilitator **settle attach** when settle is routed through `intel.twzrd.xyz`

**This package only implements step 1** (preflight) + opt-in enforcement primitives.
It does **not** call `GET /v1/intel/merchant_card` and does **not** auto-refuse on
`wash_flagged` by itself. For merchant_card + wash refuse + paid trust actions, use
[`@wzrd_sol/eliza-plugin`](https://www.npmjs.com/package/@wzrd_sol/eliza-plugin)
(`preSpendGate`, `WZRD_MERCHANT_CARD`). For fetch-level wrap of every 402, use
[`twzrd-x402-gate`](https://www.npmjs.com/package/twzrd-x402-gate).

## Install

```bash
npm install @wzrd_sol/plugin-trustgate
```

## Use (3 lines)

```ts
import { trustGatePlugin, canSpendSafely } from "@wzrd_sol/plugin-trustgate";
const agent = { plugins: [trustGatePlugin /* ...your others */] };   // 1. agent SEES trust in context
if (!(await canSpendSafely(payTo))) throw new Error("TWZRD: blocked seller"); // 2. hard stop before signing
```

Runnable end-to-end (no auth, no key): [`examples/first-installer.ts`](./examples/first-installer.ts) -
`npx tsx examples/first-installer.ts`. Against the live gate it blocks a real
wash-flagged seller (decision `block`) and proceeds on a clean one (decision `warn`).

## How it works

- **`trustGateProvider`** injects `BLOCK / WARN / ALLOW` + score for the counterparty seller into the agent's context, so the model won't choose to pay a blocked merchant in the first place.
- **`canSpendSafely(sellerWallet)`** is the enforcement primitive your payment action calls before signing: `false` = do not pay. It hits free `POST https://intel.twzrd.xyz/v1/intel/preflight` and blocks on `decision === "block"` (sellers TWZRD flags as high-risk via preflight).
- **Enforcement is opt-in:** the plugin does **not** auto-intercept signatures - your payment action must call `canSpendSafely(payTo)`. The provider only makes the model *aware*.
- **Fail-closed by default:** a preflight outage blocks the payment (`canSpendSafely` returns `false`, verdict carries `gateAvailable: false`) so an intel hiccup never silently approves a spend. Set `failOpen: true` to opt into legacy allow-on-outage (liveness > security).

## Config

```ts
import { checkTrust, createTrustGateProvider } from "@wzrd_sol/plugin-trustgate";

const verdict = await checkTrust(payTo, {
  minScore: 0,     // also block when trust_score < this. Default 0 (decision-only).
  failOpen: false, // true = allow on a preflight outage (legacy). Default false (fail-closed).
  timeoutMs: 4000,
  intelBase: "https://intel.twzrd.xyz",
});
//   -> { decision, trustScore, blocked, reason, gateAvailable }

const provider = createTrustGateProvider({ failOpen: true }); // opt into legacy allow-on-outage
```

**Sharp edge - `minScore`:** unknown sellers score **45** (`default_no_data`), so `minScore > 45` blocks *every* not-yet-seen merchant, not just bad ones. Use it deliberately; decision-only (`minScore: 0`) blocks just the wash-flagged `block` verdicts from preflight.

Powered by the TWZRD agent-intel corpus (the independent scorer on the real Solana x402 payment graph). MIT.

## withTwzrdGuard (convenience wrapper)

```ts
import { withTwzrdGuard } from "@wzrd_sol/plugin-trustgate";

// Throws on block-rated seller before calling fn; passes through on allow/warn.
// Note: this is preflight-only (not the same as twzrd-x402-gate's fetch wrapper).
await withTwzrdGuard(payTo, () => signAndSendPayment(payTo, amount));
```

## Facilitator operators

Screen **every settlement** brokered by your self-hostable x402 facilitator with the
`/facilitator` subpath export (dep-free, no `@elizaos/core`, no `@x402/core`):

```bash
npm install @wzrd_sol/plugin-trustgate
```

```ts
import { createFacilitator } from "@daydreamsai/facilitator";
import { createOnBeforeSettleHook } from "@wzrd_sol/plugin-trustgate/facilitator";

const facilitator = createFacilitator({
  svmSigners: [/* your Solana signer */],
  hooks: { onBeforeSettle: createOnBeforeSettleHook() }, // screens every settle via preflight
});
```

See [`docs/facilitator-trust-in-3-lines.md`](https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/facilitator-trust-in-3-lines.md) for full options and no-seam fallback.

No hook seam on your facilitator? Gate at the resource server instead:

```ts
import { canSpendSafely } from "@wzrd_sol/plugin-trustgate";
// between /verify and requesting /settle:
if (!(await canSpendSafely(payTo))) { /* refuse to settle */ }
```

Optional product pitch (not implemented in this package): settling **through** TWZRD
(`POST https://intel.twzrd.xyz/settle`) may attach free merchant intel + receipt for
`payTo` - see live `GET /supported` `twzrd` block.
