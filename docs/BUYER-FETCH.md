# Buyer fetch implementation and verification

`createBuyerFetch` is the new package front door. It composes existing amount
parsing, selected-offer fields, free preflight policy, file spend ledger and
file decision ledger with the official x402 pre-sign boundary. It makes no paid
TWZRD request and adds no fulfillment behavior. Existing integration APIs keep
their defaults. The quickstart leads with an executable offline refusal.

## Contract

- `maxPricePerCall` and `allowedRecipients` are explicit and required.
- Optional `expectedAmount` (after 0.12.3) binds the challenge to the caller's
  quote. Any other atomic amount on the selected requirement refuses with
  `expected_amount_mismatch`; a per-payment function that returns no decimal
  string or throws refuses with `expected_amount_unavailable`. It is a separate
  check from `maxPricePerCall`, which keeps `price_cap_exceeded`.
- Preflight blocks, unavailable checks, malformed/unscored requirements, local
  write failures and unauthorized recipients do not reach payment creation.
- Legacy fail-open and disable environment variables cannot bypass this API.
- Decisions are flushed locally before signing. Resource origin is retained;
  request paths/queries, headers, signatures and response bodies are not stored.
- The optional hourly budget checks pending reservations plus local history.
  Spend is conservatively committed before the signer; its record is an
  authorized attempt, not confirmation that a transfer settled.
- Files are single-process resources. The shared instance/reservation maps
  coordinate wrappers within that process, not different host processes.
- Dedicated clients must be configured before wrapping. Later bypass hooks,
  altered signers and payment calls outside the returned fetch are not covered.

Free checks still send the selected seller, resource and quoted price to the
configured intel endpoint. Local decision recording sends no extra request.
No `/quick`, `/trust`, decision upload or delivery capture is wired here.

## Verification

RED: the new consumer test initially failed because the wrapper entry point
did not exist. The first implementation then exposed loss of the typed refusal
when the upstream fetch wrapper rewrapped an exception. The per-request refusal
is now retained, and the test asserts the public error class and reason.

GREEN:

```bash
npx tsx --test twzrd-x402-gate/test/buyer-fetch.test.ts
npm run ci
npm run pack-smoke --workspace=twzrd-x402-gate
npm run pack-release-contract --workspace=twzrd-x402-gate
npm run buyer-consumer-smoke --workspace=twzrd-x402-gate
```

The consumer smoke packs this source, installs it in an isolated directory with
explicit x402 peers, invokes the installed CLI, then checks a shared budget in
two fresh Node processes. Every merchant and intel response in that smoke is
synthetic. The first process reaches a fixture payment payload; the restarted
process refuses before that boundary. No wallet keys or live funds are used.

The executable-bin test initially caught an unstaged new CLI file; its executable
Git mode is recorded before the passing CI run. Typechecks, existing gate and
verifier tests, package-surface checks and documentation checks remain green.

SCOPE: no live signing, paid API call, outside-agent execution, outreach, registry
release or deployment. Internal tests and isolated installations do not establish
outside adoption or close the first-outside-proof milestone. The API was first
published in 0.12.3; a locally packed tarball is for testing an unpublished build,
not an assertion about npm's contents.
