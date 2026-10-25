# Demand Desk authorization v2

Status: implementation contract for the next integration slice. The validator
and schema exist in `twzrd-x402-gate`; no wallet adapter or backend endpoint is
wired by this change.

## Invariant

The deployed Solana vault program is immutable. The Demand Desk Ed25519 key is
the sovereign spend-authorization root. Validation happens locally after a
transaction is constructed and before any wallet signer or RPC send method is
called. No registry, replacement program, PDA migration, SAS attestation,
ERC-8004 record, or cross-chain bridge participates in this decision.

`twzrd.payment_decision.v1` remains the portable public decision receipt. A
`2.0.0-demand-desk` record is different: it is a short-lived authorization to
sign one exact capital-moving vault instruction.

## Wire contract and signing

The authoritative machine-readable shape is
`schemas/demand-desk-authorization.v2.schema.json`. The initial proposal needed
four additional bindings to implement the stated security boundary:

- `intent.facilitator_id` binds the selected facilitator.
- `intent.network` binds the CAIP-2 chain and cluster.
- `settlement_constraints.vault_program_id` binds the immutable program.
- `settlement_constraints.policy_pda` binds the vault policy used by the spend.

The signature covers **every field except `signature`**, including
`contract_version`, `authorization_id`, both timestamps, and
`demand_desk_pubkey`. Signing only the four nested objects would allow unsigned
identity and lifetime changes.

The signed bytes are:

```text
UTF8("twzrd.demand_desk_authorization.v2\n") ||
UTF8(canonicalJson(authorization_without_signature))
```

The existing frozen `canonicalJson` encoder is used. The Desk must emit values
in the schema's exact types and must not rely on JSON key insertion order.
Signatures may be 64-byte Ed25519 signatures encoded as lowercase/uppercase hex
or base58. Verifiers decode the embedded public key but trust it only when it is
also present in local `trustedDemandDeskPubkeys` configuration.

The instruction digest is:

```text
SHA256(
  UTF8("twzrd.solana.instruction.v1\n") ||
  UTF8(canonicalJson({
    program_id,
    accounts: [{ pubkey, is_signer, is_writable }, ...],
    data_base64
  }))
)
```

Account order and flags are significant. The digest is over an instruction
projection produced from the locally constructed transaction, never over fields
copied from the authorization response.

Initial v2 policy deliberately accepts exactly one instruction: the immutable
vault spend. Compute-budget, memo, ATA-creation, address-lookup ambiguity, and
any other extra instruction are refused. Supporting a multi-instruction message
requires a separately versioned whole-message commitment; adapters must not
silently relax this rule.

## Validator usage

```ts
import {
  verifyDemandDeskAuthorization,
  type DemandDeskAuthorization,
} from "twzrd-x402-gate";

const result = verifyDemandDeskAuthorization(
  authorization as DemandDeskAuthorization,
  {
    trustedDemandDeskPubkeys: config.demandDeskPubkeys,
    nowMs: clock.now(),
    intent: localIntent,
    settlement: {
      vaultAddress: config.vaultAddress,
      vaultProgramId: config.immutableVaultProgramId,
      policyPda: localPolicyPda,
    },
    instructions: [decodedVaultInstruction],
    networkFeeLamports: locallyEstimatedFee,
  },
);

if (!result.ok) {
  throw new Error(`TWZRD_DEMAND_DESK_REFUSED:${result.code}`);
}
```

Validation is offline and fail closed. It verifies strict shape, supported
version, locally pinned Desk key, Ed25519 signature, issuance/expiry and maximum
TTL, signed `ALLOW/APPROVED`, exact local intent, local vault/program/policy,
required vault accounts, exact instruction digest, and fee ceiling. The default
maximum TTL is 120 seconds and default future-clock tolerance is 5 seconds.

Authorization validation does not provide replay protection by itself. The
Demand Desk remains responsible for atomic `authorization_id` consumption and
identical-retry semantics. A later local ledger may add defense in depth, but it
cannot replace the Desk's atomic decision ledger.

## Wallet middleware

The common adapter sequence is fixed:

1. Parse the 402 challenge and build a normalized local intent.
2. Construct the immutable-vault instruction without invoking a signer.
3. Obtain an authorization from the Demand Desk endpoint.
4. Decode the locally constructed instruction into the projection above.
5. Call `verifyDemandDeskAuthorization` with local trusted keys and local
   expectations.
6. Only after `{ ok: true }`, call the underlying wallet signer. Send the signed
   transaction through the normal client path.

Missing tokens, endpoint failures, malformed transactions, unsupported
transaction forms, and every non-`ok` verifier result must throw before the
signer and before an RPC socket is opened. The authorization endpoint is called
by orchestration before entering the signing boundary; the signer wrapper itself
does no network lookup.

### Standard SVM adapter

Wrap every money-moving method, not just the happy-path helper:

```ts
type PreSignContext = {
  authorization: unknown;
  intent: DemandDeskAuthorizationIntent;
  networkFeeLamports: number;
};

async function guardedSignTransaction(tx: Transaction, ctx: PreSignContext) {
  const instruction = projectSingleImmutableVaultInstruction(tx);
  const check = verifyDemandDeskAuthorization(ctx.authorization, {
    trustedDemandDeskPubkeys,
    intent: ctx.intent,
    settlement: { vaultAddress, vaultProgramId, policyPda },
    instructions: [instruction],
    networkFeeLamports: ctx.networkFeeLamports,
  });
  if (!check.ok) throw new DemandDeskBlockedError(check.code);
  return underlyingWallet.signTransaction(tx);
}
```

Apply the same guard independently to `signTransaction`, each item passed to
`signAllTransactions`, `signAndSendTransaction`, and any convenience method
that can sign or send. Never treat a previous check of a mutable transaction
object as sufficient: project and verify immediately before each signing call.
Do not expose the unwrapped wallet object to tools that can spend.

The transaction projector must reject unresolved address lookup tables,
unknown instruction decoders, a non-vault program, missing accounts, duplicate
or extra instructions, and data that cannot be reproduced byte-for-byte. It
must derive the fee locally; no caller-supplied fee may bypass the signed cap.

### ElizaOS adapter

Install the same wrapper at the wallet-provider boundary used by actions and
plugins. Prompt instructions and action-level advisory checks are not security
boundaries. The ElizaOS integration must:

- retain the raw underlying provider only inside the guard factory;
- require a `PreSignContext` on every spend-capable operation;
- route `signTransaction`, batch signing, and sign-and-send through the common
  verifier;
- refuse when tool input cannot be normalized to the exact local intent;
- keep read-only wallet methods available without an authorization; and
- emit only authorization ID, result code, and non-secret digests to logs.

Tests must inject unsigned, forged, expired, wrong-resource, wrong-facilitator,
wrong-recipient, wrong-instruction, extra-instruction, and over-fee inputs. Each
case must assert zero signer calls and zero RPC calls. One exact fixture should
assert one signer call. The adapter tests use injected clocks and clients and
run entirely offline.

For `guarded-x402-fetch`, run the verifier after the x402 client has selected the
requirements and constructed the proposed vault instruction, but before its
payment callback signs. Returning or accepting a 402 payload is not itself a
spend; the hard boundary is the signing callback.

## Demand Desk endpoint

### Request

```http
POST /v1/demand-desk/authorizations
Authorization: Bearer <agent credential>
Idempotency-Key: <UUIDv4>
Content-Type: application/json
```

```json
{
  "intent": {
    "agent_pubkey": "<base58>",
    "resource_uri": "https://merchant.example/pay/weather?city=berlin",
    "facilitator_id": "cdp-bazaar",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "merchant_recipient": "<seller token account>",
    "asset_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount_units": "10000"
  },
  "settlement": {
    "vault_address": "<vault account>",
    "vault_program_id": "4sJCaN...ryGS",
    "policy_pda": "<policy account>",
    "instruction": {
      "program_id": "4sJCaN...ryGS",
      "accounts": [
        { "pubkey": "<base58>", "is_signer": false, "is_writable": true }
      ],
      "data_base64": "<exact instruction bytes>"
    },
    "network_fee_lamports": 5000
  }
}
```

The endpoint authenticates the agent and resolves its leash/budget policy. The
caller supplies intent and a proposed exact instruction, but cannot supply the
Desk key, evidence result, timestamps, decision, digest, or signature.

The Desk parses the instruction with the immutable program's checked decoder;
confirms instruction discriminant, agent session key, policy PDA, vault,
recipient token account, mint, and amount; confirms chain, facilitator, resource
and quote bindings; evaluates local intel, freshness, wash threshold and buyer
budget; verifies the cited evidence's transparency-log inclusion; computes the
instruction digest itself; atomically reserves/consumes the authorization ID;
then signs the complete response with the sovereign Desk key.

The private key must live behind the Desk signing service or managed key
boundary. It is never accepted from a request, returned in a response, placed in
application logs, or distributed to runtime adapters.

### Response

`200 OK` returns the schema object for either `ALLOW` or `REFUSE`. Returning a
signed refusal gives clients one verifiable response contract, but only the
exact `ALLOW/APPROVED` pair authorizes signing. A repeated byte-identical request
with the same idempotency key returns the byte-identical authorization. Reusing
the key with a different request digest returns `409`.

Other failures:

- `400`: malformed request or invalid public-key/integer encoding.
- `401`/`403`: missing credentials or agent not permitted to request spend.
- `409`: idempotency-key collision with a different request.
- `422`: transaction cannot be decoded into the strict one-instruction form.
- `503`: policy, intel, log, ledger, or signer unavailable; no token is issued.

Known policy refusals use the signed reason codes in the schema. Infrastructure
failures do not get mislabeled as policy refusals and never fall through to an
allow.

## Delivery boundary

This slice supplies the strict contract, offline verifier, instruction hashing,
tests, and integration specification. Follow-on changes should be separate and
ordered: first wire and falsify the SVM/ElizaOS pre-sign adapters; then implement
the endpoint and atomic Desk ledger; finally run the existing immutable-vault
harness on local validator/devnet. None of those steps requires or permits a new
program deployment.
