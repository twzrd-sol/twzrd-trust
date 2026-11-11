# Example: `@twzrd1111/agent-killswitch` inside Mastra's `beforeToolCall`

Enforce the killswitch admission budgets **inside the agent**, before any
tool executes — no proxy, no daemon, no file I/O in the hook itself.

Requires `@mastra/core` **1.49.0 or later** (agent-level `hooks`, documented
at <https://mastra.ai/docs/agents/tools>) and the published
`@twzrd1111/agent-killswitch` **0.1.11**. The example itself does not
depend on `@mastra/core`; the hook is a plain function Mastra calls, and
`createAgentKillswitchHooks()` type-checks as Mastra's `ToolHooks`.

## Install and test

```sh
cd examples/mastra-agent
npm ci        # @twzrd1111/agent-killswitch@0.1.11 from the npm registry
npm test      # node --test __tests__/ (offline; Node 22.18+ runs the .ts directly)
```

`__tests__/budget-hook.test.ts` models Mastra's semantics with a mock tool
runner: `beforeToolCall` runs first, `{ proceed: false, output }` skips the
tool, anything else executes; `afterToolCall` settles the hold.

## Wire it into an agent

```ts
import { Agent } from '@mastra/core/agent';
import { budgetInputForChatRequest } from '@twzrd1111/agent-killswitch';
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
    // Best: build the exact request text the tool will send and read it.
    // (requestTextFor is yours: the JSON text the tool will POST.)
    if (toolName === 'summarize') return budgetInputForChatRequest(requestTextFor(input));
    // Otherwise pass a bound the tool enforces: it must never send more than
    // promptBytes bytes of text-only request. Without promptBytes and
    // promptTextOnly every call holds at least maxCostPerRequestUsd.
    return { model: 'gpt-4o-mini', maxTokens: 500, promptBytes: 4_000, promptTextOnly: true };
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
- **Prompt size** (0.1.11): the estimate bounds the prompt at one token per
  byte of the request text. Unless a call gives both `promptBytes` and
  `promptTextOnly: true`, it is held at `maxCostPerRequestUsd` or more, so an
  hourly budget smaller than that cap refuses every such call.
  `budgetInputForChatRequest(text)` returns `model`, `maxTokens`,
  `promptBytes` and `promptTextOnly` for the exact text you send.
- **Spent windows** (0.1.11): while the hour or day is at or over its limit,
  every call that passes the kill switch and pause checks is refused with
  `budget_exceeded`, the daily refusal first when both are spent.
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
