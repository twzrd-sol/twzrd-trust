# Circle wallet with a seller check before it signs

A Circle developer-controlled wallet that asks TWZRD about the seller before it signs an
x402 payment on Circle Gateway.

Circle wallet policy already covers spending limits, recipient allow and block lists,
and sanctions screening. A static list can't judge a seller nobody has listed yet. This
example puts that judgement in front of the signature: the wallet is asked to sign only
when the TWZRD check allows the seller at that price.

## What it does

1. Reads Circle Gateway's live supported list (`GET /v1/x402/supported`) and takes the
   Base offer: scheme `exact`, `GatewayWalletBatched`, USDC.
2. Builds that offer for three sellers and runs the free TWZRD check on each with
   `twzrd-x402-gate` in strict mode:

   | Seller | Price | TWZRD | Wallet asked to sign |
   |---|---|---|---|
   | has Base x402 settlement history | $0.01 | allow | once |
   | no one has seen before | $0.01 | warn, cannot spend | never |
   | has history, asking $25 | $25.00 | over its recommended cap of $2.80 | never |

3. On allow, builds the EIP-712 `TransferWithAuthorization` under the
   `GatewayWalletBatched` domain and asks the wallet to sign it. The domain, the fields
   and the timing match Circle's own client, `@circle-fin/x402-batching`.

The signature is printed, truncated, and thrown away. Nothing is sent to Gateway or to a
seller, and no USDC moves. The table shows the live answers on 2026-11-17. Live
answers can change; the demo checks only that the wallet signs exactly when the
gate allows.

## Run it

```bash
npm install
npm start      # live: Circle Gateway list + the free TWZRD check
npm test       # offline: recorded responses, a stand-in Circle wallet API
```

Without Circle keys, `npm start` uses a dry-run signer. That signer records the typed
data it would send to Circle and signs nothing. To sign with a real developer-controlled
wallet, set these variables:

```bash
CIRCLE_API_KEY=...        # TEST_API_KEY:... works
CIRCLE_ENTITY_SECRET=...  # 32-byte hex, registered with Circle
CIRCLE_WALLET_ID=...      # an EOA wallet; Gateway verifies with ecrecover, so not an SCA
npm start
```

The signer calls `POST /v1/w3s/developer/sign/typedData`, with a fresh
`entitySecretCiphertext` on each request.

## Where to take it

- **Agent wallets.** The same check fits in front of a Circle agent wallet's x402 payment.
- **Recipient blocklist.** TWZRD verdicts could feed the blocklist as a live list.
- **Arc.** `twzrd-x402-gate` prices Arc USDC on `main` (not yet in a published release).
  Arc sellers stay unscored until Arc settlements are indexed, so strict mode refuses
  them today.
