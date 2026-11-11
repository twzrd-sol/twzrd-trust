# Example: `@twzrd1111/agent-killswitch` inside Mastra's `beforeToolCall`

Enforce the killswitch admission budgets **inside the agent**, before any
tool executes — no proxy, no daemon, no file I/O in the hook itself.

Requires `@mastra/core` **1.49.0 or later** (agent-level `hooks`, documented
at <https://mastra.ai/docs/agents/tools>). The example itself does not
depend on `@mastra/core`; the hook is a plain function Mastra calls.

## Install and test (offline)

```sh
# from the repository root of twzrd-trust
npm --prefix ../../agent-killswitch run build   # dist/api.js must exist
cd examples/mastra-agent
npm install --offline                          # file: dependency, no network
npm test                                       # node --test __tests__/
```

`__tests__/budget-hook.test.ts` models Mastra's semantics with a mock tool
runner: `beforeToolCall` runs first, `{ proceed: false, output }` skips the
tool, anything else executes; `afterToolCall` settles the hold.

## Wire it into an agent

```ts
import { Agent } from '@mastra/core/agent';
import { createAgentKillswitchHooks } from './budget-hook';

// Caller-owned, live window. Persist this however you like (this example
// keeps it in memory; the proxy persists a JSONL ledger instead).
const window = { minuteTokens: 0, hourUsd: 0, dayUsd: 0 };

const hooks = createAgentKillswitchHooks({
  maxTokensPerMinute: 100_000,
  maxUsdPerHour: 0.5,
  maxUsdPerDay: 2.0,
  maxCostPerRequestUsd: 0.04,
  window,
  estimate: ({ toolName, input }) => {
    // Map the tool call to the model call it stands for. Keep it pure.
    // Throwing here means the tool never executes (fail closed).
    if (toolName === 'expensiveResearch') return { model: 'gpt-4o', maxTokens: 4_000 };
    return { model: 'gpt-4o-mini', maxTokens: 500 };
  },
  // optional settle-on-completion: replace the hold with actual usage
  actualCost: ({ toolName, output }) => extractUsage(output),
});

export const agent = new Agent({
  id: 'guarded-agent',
  name: 'guarded-agent',
  instructions: '...',
  model: 'openai/gpt-4o',
  hooks, // { beforeToolCall, afterToolCall } — agent-level, applies to all tool sources
  tools: { /* ... */ },
});
```

## Semantics (normative)

- **Allow**: `beforeToolCall` returns `undefined` → Mastra executes the tool.
- **Veto**: returns `{ proceed: false, output }` → the tool **never
  executes**; the agent receives `output` as the tool result. `output` is
  the proxy's OpenAI-shaped veto body:
  `{ error: { type: "killswitch_veto", code, message, spent_usd, limit_usd, decision_id? } }`
  with `code` one of `budget_exceeded | kill_switch | payment_gate_halt |
  per_request_cap | model_not_allowed` (429-equivalent for budgets, 403 for
  the kill switch and disallowed models).
- **Hold before await, synchronously**: the estimate hold is added to
  `window` before `beforeToolCall` returns, so two parallel tool calls
  cannot both read the pre-hold window.
- **Settle**: `afterToolCall` replaces the hold with reported actuals when
  `actualCost` returns numbers; otherwise the hold remains as the billable
  estimate of the call.
- **Fail closed**: an estimate function that throws, a malformed window,
  or an inadmissible request all stop the tool call; nothing falls through
  to execution with a garbage budget state.
- **Paid calls**: pass `zeroPriceModels: []` per call (x402/MPP-carrying
  requests are priced as if not free — same rule as the proxy).

## What this example is not

- Not part of the published `@twzrd1111/agent-killswitch` package.
- Not a ledger: the window is in-memory. For the append-only JSONL spend
  ledger, `verify-ledger`, the file kill switch and the upstream proxy
  lifecycle, use the proxy (`npx @twzrd1111/agent-killswitch`).
- Not a correctness guarantee for pricing: cost rows are conservative
  estimates keyed to the requested model id, same as the proxy.
