# Operator acceptance — Gate Adoption Proof

**Package:** `twzrd-x402-gate`
**Harness:** `src/adoption-proof.ts` (`npm run adoption-proof`)
**Schemas:** `twzrd.gate_adoption_transcript.v1`, `twzrd.evidence_bundle.v1`

This is the acceptance contract cited by the `acceptanceDoc` field of every
transcript and evidence bundle the package emits. It lives here, in the public
package repo, so the operator who generates a bundle can read the document that
governs what that bundle does and does not prove.

## Goal

Make the first external operator run unambiguous and low-friction: install the
buyer-side gate, run a **no-spend** deterministic proof, and produce a JSON
transcript showing the pre-sign hook saw the exact selected requirement, emitted
a decision, blocked **without invoking a wallet signer**, and stamped attribution.

## Exact command

```bash
git clone https://github.com/twzrd-sol/twzrd-trust.git
cd twzrd-trust/twzrd-x402-gate
npm install
npm run adoption-proof -- --integration <YOUR_INTEGRATION_ID> --run-id <UUID>
```

Example:

```bash
npm run adoption-proof -- --integration acme-ops-agent-v1 \
  --run-id "$(uuidgen || python3 -c 'import uuid;print(uuid.uuid4())')"
```

Exit `0` only when `transcript.ok === true`. JSON is written to **stdout**.

> The path is `twzrd-x402-gate/`, not `packages/twzrd-x402-gate/`. The latter is
> the internal monorepo layout and does not exist in this repo.

## Expected transcript fields (required)

| Field | Expect |
|-------|--------|
| `schema` | `twzrd.gate_adoption_transcript.v1` |
| `package` | `twzrd-x402-gate` |
| `packageVersion` | matches `package.json` |
| `proofKind` | `local_deterministic_harness` |
| `mode` | `no_spend` |
| `integration` | your stable integration id |
| `runId` | the id you passed (echo it in your own issue/PR) |
| `clientHeader` | `twzrd-x402-gate/<version>` |
| `steps[0].name` | `block_path` |
| `steps[0].abort` | `true` |
| `steps[0].decisionEmitted` | `true` |
| `steps[0].signerInvocations` | `0` |
| `steps[0].selectedRequirements.payTo` | fixture seller (proves the exact requirement reached the hook) |
| `steps[0].preflightAttribution.{integration,runId,client}` | match your flags / version |
| `steps[1].name` | `allow_path` |
| `steps[1].abort` | `false` |
| `steps[1].signerInvocations` | `0` (see limits below — the signer is a stub) |
| `assertions.*` | all `true` |
| `ok` | `true` |

## What counts as EXTERNAL_RUN

All of the following, together:

1. **Operator-owned** environment — not a TWZRD CI or dogfood machine, and not
   authored solely by TWZRD.
2. A transcript with `lineage: "external_candidate"` **and** the same `runId`
   published by the operator in their own issue / PR / chat.
3. **Server-side join**: the same `X-TWZRD-Integration` + `X-TWZRD-Run-Id`
   observed on a real preflight from non-internal lineage — not this local
   harness alone.
4. Evidence the operator installed the package and ran the hook path, not only
   unit tests inside this repo.

## What does **not** count as EXTERNAL_RUN

- Package download counts
- Free preflight HTTP hits alone
- A self-authored `runId` with no operator transcript
- This harness alone, without operator ownership and a server-side join
- A live payment that succeeded without passing the gate decision path
- **A `lineage` value the run asserted about itself** (see below)

`lineage: "dogfood"` = internal, package harness, or CI. Useful for regression;
**not** external adoption.

## Limits of this harness — read before citing it

These are properties of the proof, not defects to be argued away. A reviewer is
entitled to hold the transcript to exactly this line and no further.

1. **`lineage` is self-asserted, not verified.** `lineage` is a *default*
   derived from the integration id, and an explicit `lineage` option overrides
   that default unconditionally. A run whose integration id is unambiguously
   internal can still emit `lineage: "external_candidate"`. Treat the field as
   the run's own claim about itself. Only criterion 3 above — the server-side
   join, which the operator cannot forge — promotes a candidate to EXTERNAL_RUN.
2. **The preflight is mocked.** The harness records the attribution headers and
   request body it *would* have sent. It does not prove a TWZRD server observed
   them.
3. **The signer is a stub in both paths.** `steps[1].signerInvocations` is `0`
   on the allow path because no real signer is wired, so this transcript proves
   the block path *does not* sign — it does **not** prove the allow path *can*.
   The stronger claim needs a real client and a counting signer.
4. **The client is harness-local.** `runGateAdoptionProof` drives an internal
   mock of the x402 client interface, so it demonstrates TWZRD's hook logic
   against TWZRD's own mock. It is integration evidence, not independent
   third-party execution.

## Relation to install APIs

| API | Role in this proof |
|-----|--------------------|
| `installTwzrdX402ClientHook` | **Exercised** by the harness (pre-sign hook) |
| `installTwzrdAutoGate` | Same guard/preflight stack; not re-run here, to avoid network pay wrappers |
| Attribution headers | Stamped on **preflight only** (`X-TWZRD-Integration`, `X-TWZRD-Run-Id`, `X-TWZRD-Client`) |

## Secrets and spend

- No wallet keys.
- No USDC. `mode` is `no_spend`.
- The preflight is mocked in-process, so the run is deterministic and offline.

For a live but still low-risk follow-up, point a real agent at a free preflight
with the same attribution flags. Paid spend is **not** required for this
acceptance gate.
