# @wzrd_sol/plugin-trustgate

Buyer-side **x402 trust gate** for elizaOS agents. Before your agent signs a payment to a seller, score that seller via the **free** TWZRD preflight (corpus-backed wash / sybil reputation) and refuse `block`-rated merchants. No auth, no cost, no Solana dependency in the gate, fail-open.

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

Runnable end-to-end (no auth, no key): [`examples/first-installer.ts`](./examples/first-installer.ts) —
`npx tsx examples/first-installer.ts`. Against the live gate it blocks a real
wash-flagged seller (`34w53Ukh`, decision `block`/30) and proceeds on a clean one
(`7uh2ibD1`, `warn`/45).

## How it works

- **`trustGateProvider`** injects `BLOCK / WARN / ALLOW` + score for the counterparty seller into the agent's context, so the model won't choose to pay a blocked merchant in the first place.
- **`canSpendSafely(sellerWallet)`** is the enforcement primitive your payment action calls before signing: `false` = do not pay. It hits the free `POST https://intel.twzrd.xyz/v1/intel/preflight` and blocks on `decision === "block"` (wash-flagged / captive-payer sellers).
- **Enforcement is opt-in:** the plugin does **not** auto-intercept signatures - your payment action must call `canSpendSafely(payTo)`. The provider only makes the model *aware*.
- **Fail-open by default:** a preflight outage never bricks your agent (`canSpendSafely` returns `true`, verdict carries `gateAvailable: false`). Set `failOpen: false` for strict mode (block on any outage).

## Config

```ts
import { checkTrust, createTrustGateProvider } from "@wzrd_sol/plugin-trustgate";

const verdict = await checkTrust(payTo, {
  minScore: 0,     // also block when trust_score < this. Default 0 (decision-only).
  failOpen: true,  // false = block on a preflight outage (strict). Default true.
  timeoutMs: 4000,
  intelBase: "https://intel.twzrd.xyz",
});
//   -> { decision, trustScore, blocked, reason, gateAvailable }

const provider = createTrustGateProvider({ failOpen: false }); // strict provider
```

**Sharp edge - `minScore`:** unknown sellers score **45** (`default_no_data`), so `minScore > 45` blocks *every* not-yet-seen merchant, not just bad ones. Use it deliberately; decision-only (`minScore: 0`) blocks just the wash-flagged `block` verdicts.

Powered by the TWZRD agent-intel corpus (the independent scorer on the real Solana x402 payment graph). MIT.
