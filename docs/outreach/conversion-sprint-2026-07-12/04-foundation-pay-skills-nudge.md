# Channel 4: Solana Foundation pay-skills

**PR:** https://github.com/solana-foundation/pay-skills/pull/162  
**Status:** OPEN since 2026-06-29  
**Parallel:** nudge while outbound runs; not a prerequisite for warm asks.

## Nudge comment (post on PR)

```
Friendly bump — TWZRD listing is frozen locally and Greptile-green.

Updated public proof for the pay-guard / seller-graph closeout (sanitized, no private repo links):
https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proofs/seller-graph-payguard-closeout-2026-07-12.md

Live surfaces unchanged:
- MCP: https://intel.twzrd.xyz/mcp (23 tools)
- OpenAPI sidecar in this PR
- Free preflight: POST /v1/intel/preflight

Happy to refresh the OpenAPI sidecar from live immediately before merge if helpful. Thanks for reviewing when you have bandwidth.
```

## Operator checklist before merge

```bash
curl -s https://intel.twzrd.xyz/openapi.json | python3 -m json.tool \
  > providers/twzrd/agent-intel/openapi.json
pay catalog check providers/twzrd/agent-intel/PAY.md
```