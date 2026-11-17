// Signers for the demo. Both count their calls, so the report can show the
// wallet was never asked to sign a refused payment.
import { constants, publicEncrypt, randomUUID } from "node:crypto";

const CIRCLE_API = "https://api.circle.com";

/**
 * Circle developer-controlled wallet: POST /v1/w3s/developer/sign/typedData.
 * Each request carries a fresh entitySecretCiphertext (the entity secret,
 * RSA-OAEP/SHA-256 encrypted to Circle's entity public key). Gateway checks
 * the authorization with ecrecover, so the wallet must be an EOA, not an SCA.
 */
export function circleDeveloperWalletSigner({
  apiKey,
  entitySecret,
  walletId,
  fetch: f = globalThis.fetch,
  apiBase = CIRCLE_API,
}) {
  let calls = 0;
  const auth = { authorization: `Bearer ${apiKey}` };

  async function getJson(path) {
    const res = await f(`${apiBase}${path}`, { headers: auth });
    if (!res.ok) throw new Error(`Circle GET ${path} HTTP ${res.status}`);
    return (await res.json()).data;
  }

  async function ciphertext() {
    const { publicKey } = await getJson("/v1/w3s/config/entity/publicKey");
    return publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(entitySecret, "hex"),
    ).toString("base64");
  }

  return {
    kind: "circle-developer-wallet",
    get calls() {
      return calls;
    },
    async address() {
      const { wallet } = await getJson(`/v1/w3s/wallets/${encodeURIComponent(walletId)}`);
      return wallet.address;
    },
    async signTypedData(typedData) {
      calls += 1;
      const body = {
        walletId,
        data: JSON.stringify(typedData),
        entitySecretCiphertext: await ciphertext(),
        memo: "x402 payment after a TWZRD seller check",
      };
      const res = await f(`${apiBase}/v1/w3s/developer/sign/typedData`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "x-request-id": randomUUID() },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Circle sign/typedData HTTP ${res.status}`);
      return (await res.json()).data.signature;
    },
  };
}

/** No Circle keys: record what would be sent to Circle, sign nothing. */
export function dryRunSigner() {
  let calls = 0;
  const requests = [];
  return {
    kind: "dry-run (no Circle keys set)",
    requests,
    get calls() {
      return calls;
    },
    async address() {
      return "0x000000000000000000000000000000000000dEaD";
    },
    async signTypedData(typedData) {
      calls += 1;
      requests.push(typedData);
      return null;
    },
  };
}
