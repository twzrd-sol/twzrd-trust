#!/usr/bin/env node
// A Circle wallet that asks TWZRD about the seller before it signs an x402
// payment. Reads Circle Gateway's live Base offer, screens three sellers with
// the free TWZRD check, and asks the wallet to sign only when the gate allows.
// Nothing is sent to Gateway or to a seller: no USDC moves.
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolveConfig, twzrdApprovePayment } from "twzrd-x402-gate";
import {
  GATEWAY_SUPPORTED_URL,
  authorizationTypedData,
  baseUsdcKind,
  offerFor,
} from "./lib/gateway-offer.mjs";
import { circleDeveloperWalletSigner, dryRunSigner } from "./lib/circle-signer.mjs";

const RESOURCE = "https://seller.example/api";

export const CASES = [
  {
    label: "seller with Base x402 settlement history, $0.01",
    payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
    priceUsdc: 0.01,
  },
  {
    label: "seller no one has seen before, $0.01",
    payTo: "0x7a3c5e1f9b2d4a6c8e0f1a3b5c7d9e1f2a4b6c8d",
    priceUsdc: 0.01,
  },
  {
    label: "same seller with history, asking $25",
    payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
    priceUsdc: 25,
  },
];

export async function runDemo({
  signer,
  fetch: f = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
  cases = CASES,
} = {}) {
  const res = await f(GATEWAY_SUPPORTED_URL);
  if (!res.ok) throw new Error(`Circle Gateway supported list HTTP ${res.status}`);
  const kind = baseUsdcKind(await res.json());

  // strict: a network TWZRD does not score is refused, never waved through.
  const cfg = resolveConfig({ unsupportedNetworkMode: "strict", failOpen: false, fetch: f });
  const from = await signer.address();
  const rows = [];
  for (const c of cases) {
    const offer = offerFor(kind, { ...c, resource: RESOURCE });
    const before = signer.calls;
    const approval = await twzrdApprovePayment(
      {
        resourceUrl: offer.resource,
        payTo: offer.payTo,
        chain: offer.network,
        asset: offer.asset,
        priceUsdc: Number(offer.amount) / 1_000_000,
        agentIntent: "circle_wallet_precheck",
      },
      cfg,
    );
    let signature = null;
    if (approval.approved) {
      const nonce = `0x${randomBytes(32).toString("hex")}`;
      signature = await signer.signTypedData(authorizationTypedData(kind, offer, { from, nowSeconds, nonce }));
    }
    rows.push({
      case: c.label,
      pay_to: offer.payTo,
      amount_usdc: Number(offer.amount) / 1_000_000,
      twzrd_decision: approval.card?.decision ?? null,
      gate: approval.approved ? "sign" : "refuse",
      reason: approval.reason,
      wallet_sign_calls: signer.calls - before,
      signature: typeof signature === "string" ? `${signature.slice(0, 18)}…` : null,
    });
  }
  return {
    schema: "twzrd.circle_wallet_precheck.v1",
    signer: signer.kind,
    network: kind.network,
    gateway_verifying_contract: kind.verifyingContract,
    sent_to_gateway: false,
    usdc_moved: 0,
    rows,
    // The one property this demo proves: the wallet signs exactly when the gate allows.
    consistent: rows.every((r) => r.wallet_sign_calls === (r.gate === "sign" ? 1 : 0)),
  };
}

async function main() {
  const { CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID } = process.env;
  const signer =
    CIRCLE_API_KEY && CIRCLE_ENTITY_SECRET && CIRCLE_WALLET_ID
      ? circleDeveloperWalletSigner({
          apiKey: CIRCLE_API_KEY,
          entitySecret: CIRCLE_ENTITY_SECRET,
          walletId: CIRCLE_WALLET_ID,
        })
      : dryRunSigner();
  const report = await runDemo({ signer });
  for (const r of report.rows) {
    const mark = r.gate === "sign" ? "SIGN  " : "REFUSE";
    console.log(`${mark} ${r.case}: TWZRD ${r.twzrd_decision}, ${r.reason}, wallet asked to sign ${r.wallet_sign_calls}x`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.consistent ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("circle-wallet-precheck failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
