// A loopback x402 seller. Each shop answers an unpaid GET with an x402 v2
// 402 that offers the same terms on Base and on Solana, in the
// PAYMENT-REQUIRED header and in the body. A request whose PAYMENT-SIGNATURE
// names one of those offers gets a 200. It listens on 127.0.0.1 only, settles
// nothing, and counts what reached it.
import http from "node:http";

import { RAIL_IDS, RAILS } from "./rails.mjs";

/** 0.01 USDC in base units (USDC has 6 decimals on both rails). */
export const PRICE = "10000";

export const SHOPS = Object.freeze({
  "/good": { seller: "good", amount: PRICE, asset: "usdc", about: "clean seller, 0.01 USDC" },
  "/flagged": { seller: "flagged", amount: PRICE, asset: "usdc", about: "seller the seller check refuses, 0.01 USDC" },
  "/pricey": { seller: "good", amount: "5000000", asset: "usdc", about: "5.00 USDC, over the 0.10 USDC cap" },
  "/wrong-asset": { seller: "good", amount: PRICE, asset: "non-usdc", about: "priced in a token that is not USDC" },
});

const toBase64Json = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

function fromBase64Json(text) {
  try {
    return JSON.parse(Buffer.from(String(text), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** The x402 v2 payment-required object for a shop: one offer per rail. */
export function paymentRequired(path, origin) {
  const shop = SHOPS[path];
  return {
    x402Version: 2,
    error: "payment required",
    resource: { url: `${origin}${path}`, description: shop.about, mimeType: "application/json" },
    accepts: RAIL_IDS.map((id) => ({
      scheme: "exact",
      network: RAILS[id].network,
      amount: shop.amount,
      asset: shop.asset === "usdc" ? RAILS[id].usdc : RAILS[id].nonUsdc,
      payTo: RAILS[id].sellers[shop.seller],
      maxTimeoutSeconds: 60,
    })),
  };
}

const sameOffer = (a, b) =>
  a.scheme === b.scheme && a.network === b.network && a.amount === b.amount && a.asset === b.asset && a.payTo === b.payTo;

export async function startSeller() {
  const counts = {
    requests: 0,
    unpaid: 0,
    paid: 0,
    rejected: 0,
    paidByRail: Object.fromEntries(RAIL_IDS.map((id) => [id, 0])),
  };
  let origin = "";
  const server = http.createServer((req, res) => {
    counts.requests += 1;
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method !== "GET" || !Object.hasOwn(SHOPS, path)) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    const required = paymentRequired(path, origin);
    const header = req.headers["payment-signature"];
    if (!header) {
      counts.unpaid += 1;
      res.writeHead(402, { "content-type": "application/json", "payment-required": toBase64Json(required) });
      res.end(JSON.stringify(required));
      return;
    }
    const accepted = fromBase64Json(header)?.accepted;
    const offer =
      accepted && typeof accepted === "object" ? required.accepts.find((o) => sameOffer(o, accepted)) : undefined;
    if (!offer) {
      counts.rejected += 1;
      res.writeHead(400, { "content-type": "application/json" }).end('{"error":"payment does not name an offer"}');
      return;
    }
    const railId = RAIL_IDS.find((id) => RAILS[id].network === offer.network);
    counts.paid += 1;
    counts.paidByRail[railId] += 1;
    const settlement = { success: true, network: offer.network, transaction: "demo-no-chain", payer: "demo-signer" };
    res.writeHead(200, { "content-type": "application/json", "payment-response": toBase64Json(settlement) });
    res.end(JSON.stringify({ shop: path, rail: railId, content: "demo content", settled_on_chain: false }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    snapshot: () => structuredClone(counts),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
