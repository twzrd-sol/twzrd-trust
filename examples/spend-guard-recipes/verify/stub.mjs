// Loopback-only stub: an x402 v2 seller (Base mainnet USDC, exact) and a TWZRD-shaped
// trust service. Binds 127.0.0.1 on a free port. Moves no money, verifies nothing.
import http from "node:http";

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PAY_TO = "0x1111111111111111111111111111111111111111";

export function x402Offer(amountMicro, resourceUrl) {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: { url: resourceUrl, description: "loopback paid resource", mimeType: "application/json" },
    accepts: [{
      scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amount: String(amountMicro),
      payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
    }],
  };
}

/**
 * opts.priceMicro: map path -> amount (micro USDC) for /x402/<name>
 * opts.trust: "down" (503) | "allow" (score 90, wash clean) for /v1/intel/*
 * opts.mpp: optional (req, res, hits) => boolean handler for /mpp/*
 */
export async function startStub(opts = {}) {
  const hits = [];
  const state = { trust: opts.trust ?? "down", priceMicro: { ...(opts.priceMicro ?? {}) } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname.startsWith("/v1/intel/")) {
      hits.push("intel:" + url.pathname);
      if (state.trust === "down") return json(503, { error: "loopback trust stub is down on purpose" });
      if (url.pathname.startsWith("/v1/intel/preflight")) {
        let posted = {};
        try { posted = JSON.parse(body); } catch {}
        const wallet = String(posted.seller_wallet ?? "");
        return json(200, { readiness_card: { decision: "allow", trust_score: 90, can_spend: true,
          seller_wallet: wallet, maximum_recommended_spend_usdc: 5 } });
      }
      if (url.pathname.startsWith("/v1/intel/merchant_card/")) {
        const wallet = decodeURIComponent(url.pathname.slice("/v1/intel/merchant_card/".length));
        return json(200, { wallet, wash_flagged: false, wash_confidence: "full" });
      }
      return json(404, { error: "not stubbed" });
    }
    if (url.pathname.startsWith("/x402/")) {
      const name = url.pathname.slice("/x402/".length);
      const pay = req.headers["payment-signature"] ?? req.headers["x-payment"];
      if (pay) {
        hits.push("x402-payment:" + name);
        return json(200, { ok: true, paid: name });
      }
      hits.push("x402-challenge:" + name);
      const doc = x402Offer(state.priceMicro[name] ?? 50000, "http://127.0.0.1" + url.pathname);
      return json(402, doc, { "payment-required": Buffer.from(JSON.stringify(doc)).toString("base64") });
    }
    if (url.pathname.startsWith("/mpp/") && opts.mpp && opts.mpp(req, res, hits, url)) return;
    hits.push("other:" + url.pathname);
    json(404, { error: "no such path" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    base: "http://127.0.0.1:" + port, port, hits, state,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
