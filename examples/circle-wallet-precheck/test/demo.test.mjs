// Offline: replays TWZRD and Circle Gateway responses recorded 2026-11-17 and
// stands in for Circle's wallet API, so no request leaves the process.
import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CASES, runDemo } from "../demo.mjs";
import { circleDeveloperWalletSigner, dryRunSigner } from "../lib/circle-signer.mjs";
import { baseUsdcKind } from "../lib/gateway-offer.mjs";

const rec = JSON.parse(readFileSync(new URL("../fixtures/recorded-2026-11-17.json", import.meta.url)));
const NOW = 1_795_000_000;
const ENTITY_SECRET = "11".repeat(32);
const WALLET_ID = "8f1c2b8e-4c3a-4f5e-9a0b-1d2e3f405162";
const WALLET_ADDRESS = "0x1234567890AbcdEF1234567890aBcdef12345678";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function world() {
  const seen = [];
  const signRequests = [];
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    seen.push(`${method} ${url.host}${url.pathname}`);
    if (url.href === "https://gateway-api.circle.com/v1/x402/supported") return json(rec.circle_supported);
    if (url.host === "intel.twzrd.xyz") {
      const body = init.body ? JSON.parse(init.body) : null;
      const hit = rec.intel.find((r) => {
        if (r.method !== method || new URL(r.url).pathname !== url.pathname) return false;
        if (!body) return true;
        return r.request.seller_wallet === body.seller_wallet && r.request.price_usdc === body.price_usdc;
      });
      if (!hit) throw new Error(`no recorded intel response for ${method} ${url.pathname}`);
      return json(hit.response, hit.status);
    }
    if (url.host === "api.circle.com") {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer TEST_API_KEY:id:secret");
      if (url.pathname === "/v1/w3s/config/entity/publicKey") {
        return json({ data: { publicKey: publicKey.export({ type: "spki", format: "pem" }) } });
      }
      if (url.pathname === `/v1/w3s/wallets/${WALLET_ID}`) {
        return json({ data: { wallet: { id: WALLET_ID, address: WALLET_ADDRESS } } });
      }
      if (url.pathname === "/v1/w3s/developer/sign/typedData" && method === "POST") {
        signRequests.push(JSON.parse(init.body));
        return json({ data: { signature: `0x${"ab".repeat(65)}` } });
      }
    }
    throw new Error(`unexpected request ${method} ${url.href}`);
  };
  return { fetch, seen, signRequests };
}

test("the wallet is asked to sign only the payment the gate allows", async () => {
  const w = world();
  const signer = dryRunSigner();
  const report = await runDemo({ signer, fetch: w.fetch, nowSeconds: NOW });
  assert.deepEqual(
    report.rows.map((r) => [r.gate, r.wallet_sign_calls]),
    [["sign", 1], ["refuse", 0], ["refuse", 0]],
  );
  assert.equal(report.rows[1].reason, "twzrd_unevaluated_subject_unknown_subject");
  assert.equal(report.rows[2].reason, "twzrd_over_recommended_cap_25_gt_2.8");
  assert.equal(report.consistent, true);
  assert.equal(report.sent_to_gateway, false);
  assert.equal(signer.calls, 1);
});

test("the signed authorization matches Circle Gateway's Base offer", async () => {
  const w = world();
  const signer = dryRunSigner();
  await runDemo({ signer, fetch: w.fetch, nowSeconds: NOW });
  const [td] = signer.requests;
  const kind = baseUsdcKind(rec.circle_supported);
  assert.deepEqual(td.domain, {
    name: "GatewayWalletBatched",
    version: "1",
    chainId: 8453,
    verifyingContract: kind.verifyingContract,
  });
  assert.equal(td.primaryType, "TransferWithAuthorization");
  assert.equal(td.message.to, CASES[0].payTo);
  assert.equal(td.message.value, "10000");
  assert.equal(td.message.validAfter, String(NOW - 600));
  assert.equal(Number(td.message.validBefore) - NOW, kind.minValiditySeconds + 100);
  assert.equal(kind.minValiditySeconds, 604800);
  assert.match(td.message.nonce, /^0x[0-9a-f]{64}$/);
});

test("Circle developer wallet: one sign/typedData call, fresh entity secret ciphertext", async () => {
  const w = world();
  const signer = circleDeveloperWalletSigner({
    apiKey: "TEST_API_KEY:id:secret",
    entitySecret: ENTITY_SECRET,
    walletId: WALLET_ID,
    fetch: w.fetch,
  });
  const report = await runDemo({ signer, fetch: w.fetch, nowSeconds: NOW });
  assert.equal(w.signRequests.length, 1);
  const [req] = w.signRequests;
  assert.equal(req.walletId, WALLET_ID);
  const td = JSON.parse(req.data);
  assert.equal(td.message.from, WALLET_ADDRESS);
  assert.equal(td.message.to, CASES[0].payTo);
  const secret = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(req.entitySecretCiphertext, "base64"),
  );
  assert.equal(secret.toString("hex"), ENTITY_SECRET);
  assert.match(report.rows[0].signature, /^0xabab/);
  assert.equal(report.rows[1].signature, null);
  assert.ok(!w.seen.some((s) => s.includes("gateway-api.circle.com/v1/x402/settle")));
});

test("no Base GatewayWalletBatched kind: refuse to run", () => {
  assert.throws(() => baseUsdcKind({ kinds: [] }), /no GatewayWalletBatched kind on Base/);
});
