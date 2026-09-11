# Agent Commerce Kit

Canonical, replayable contract for the full agent-commerce lifecycle:

`discover → preflight → policy decision → payment intent → settlement → delivery → signed receipt → outcome/evidence`

The schema is [`contract/agent-commerce-loop.schema.json`](contract/agent-commerce-loop.schema.json). Every loop carries stable loop/resource IDs; payer, seller, facilitator and custody roles; exact price; allow/warn/block policy; independent payment and delivery states; settlement/receipt references; explicit `house`, `sponsored`, or `external` attribution; and an ordered evidence log.

## Reference surfaces

- TypeScript client: `src/index.ts`
- Python lifecycle/verification/replay/export client: `python/agent_commerce.py`
- MCP tools over JSON-RPC stdio: `src/mcp.ts`
- Local simulator: `src/simulator.ts` and `npm run build && node dist/cli.js external allow`
- Evidence exporter: `src/evidence.ts`

The simulator never broadcasts a transaction. Its signer counter proves where signing would occur, and replay always reports `spend_attempts: 0`.

## Verify

```bash
npm test --workspace=@twzrd/agent-commerce-kit
```

Acceptance tests prove blocked sellers never reach signing, allowed settlements have cross-language verifiable Ed25519 receipts, payment and delivery failures remain distinct, activity classes never collapse, and full journeys replay without spending.

## Public framework example

The [`examples/elizaos`](examples/elizaos) copy-paste example runs discovery, live TWZRD preflight, unsafe refusal, safe simulation, receipt verification, evidence export, and activity-separated measurement as one ElizaOS action.
