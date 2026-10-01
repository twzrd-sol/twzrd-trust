# Facilitator trust in 3 lines

Screen every settlement a self-hosted x402 facilitator brokers, using `@wzrd_sol/plugin-trustgate`. The hook asks the free TWZRD preflight about the seller wallet and aborts the settle when the verdict is a block. This page describes the package's `./facilitator` entry; its types are in `plugin-trustgate/dist/facilitator.d.ts`.

```bash
npm install @wzrd_sol/plugin-trustgate
```

```ts
import { createFacilitator } from "@daydreamsai/facilitator";
import { createOnBeforeSettleHook } from "@wzrd_sol/plugin-trustgate/facilitator";

const facilitator = createFacilitator({
  svmSigners: [/* your Solana signer */],
  hooks: { onBeforeSettle: createOnBeforeSettleHook() },
});
```

The hook matches the `onBeforeSettle(ctx)` contract of `daydreamsai/facilitator`: returning nothing lets the settle proceed, and returning `{ abort: true, reason }` stops it. It reads the seller (`payTo`) and network from `ctx.requirements`, falling back to `ctx.paymentPayload.accepted`.

## Options

| Option | Default | Meaning |
|---|---|---|
| `intelBase` | `https://intel.twzrd.xyz` | Preflight host |
| `timeoutMs` | `500` | Milliseconds before the hook gives up on the preflight |
| `failOpen` | `false` | `false` blocks the settle when the preflight is unreachable; `true` allows it |
| `solanaOnly` | `true` | Only settles on a Solana network are checked (`solana:*`, plus `mainnet-beta`, `mainnet`, `devnet`, `testnet` and `localnet`); other networks pass through unchecked |
| `minScore` | `0` | Also block when the trust score is below this, even if the decision is not `block`. Unknown sellers score 45, so a value above 45 blocks every seller not seen before |
| `onVerdict` | none | Callback that receives every verdict the hook computes, including allows and outage results. It is not called when the hook returns early (no seller wallet, or a non-Solana network) |
| `fetchImpl` | `globalThis.fetch` | Inject a fetch for tests or runtimes without one |

## No hook seam on your facilitator

Check at the resource server instead, between `/verify` and requesting `/settle`:

```ts
import { canSpendSafely } from "@wzrd_sol/plugin-trustgate";

if (!(await canSpendSafely(payTo))) {
  // refuse to settle
}
```

`canSpendSafely` returns `false` whenever the verdict is blocked: a preflight block, a `minScore` block, or an unreachable preflight with `failOpen` off. Its own default timeout is 4000 ms (the hook's is 500 ms).

## What this does and does not do

- It screens the seller wallet. It does not inspect the buyer, the amount, or the delivered resource.
- A pass is not a guarantee; it means the free preflight did not return a block.
- If the settle context carries no seller wallet, there is nothing to score and the hook allows the settle.
- With `solanaOnly` on, a settle whose network is empty is treated as possibly Solana and is checked; only a confirmed non-Solana network passes through unchecked.
- Solana only by default, because the observed corpus the checks use is Solana.
