/**
 * A loopback world: one server on 127.0.0.1 that plays a paid seller, the
 * TWZRD trust service and a paid MCP server, plus a payer that signs with a
 * throwaway key. It moves no money and touches no chain. It exists so the
 * mandate can be exercised end to end, and its breakers proven, on a machine
 * with no wallet and no network.
 *
 * The receipt the loopback seller returns is a recorded production receipt
 * (a V7 receipt TWZRD issued about its own seller wallet) with its recorded
 * Merkle inclusion proof. Both verify under the pinned production keys, so
 * the receipt path here is the real one, on a replayed document.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { strictBase64ToUtf8 } from "./challenge.js";
import type { WrapPay } from "./runtime.js";

/** The recorded receipt's subject: TWZRD's own seller wallet. The loopback seller is paid at it. */
export const LOOPBACK_SELLER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
export const LOOPBACK_WASH_SELLER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
export const LOOPBACK_BASE_SELLER = "0x1111111111111111111111111111111111111111";
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

/** The recorded V7 receipt. */
export function recordedReceipt(): unknown {
  return fixture("receipt-v7.json");
}

/** The recorded inclusion proof of that receipt. */
export function recordedInclusion(): unknown {
  return fixture("receipt-v7-log-inclusion.json");
}

export interface LoopbackProduct {
  priceMicro: number;
  payTo: string;
  network: string;
  asset: string;
  scheme: string | undefined;
  /** How the 402 carries its challenge. */
  challenge: "body" | "header" | "noncanonical-header" | "garbage" | "mpp";
  /** Extra payment options listed after the main one. */
  extraOffers: Record<string, unknown>[];
  /** What the 402 names from its second appearance on (a seller that swaps its offer). */
  swapPayToAfterFirst: string | null;
  /** What the seller answers once it has taken a valid payment. */
  afterPayStatus: number;
  /** What the seller reports it charged; null means the price. */
  billMicro: number | null;
  /** The raw settlement header, when set; `false` sends none. */
  settlementHeader: string | false | null;
  receipt: unknown;
  inclusion: unknown;
  /** Answer 200 without asking for payment. */
  free: boolean;
}

export interface LoopbackTrust {
  decision: "allow" | "warn" | "block";
  score: number;
  washFlagged: boolean;
}

export interface LoopbackWorld {
  base: string;
  /** The trust service is the same loopback server. */
  intelBase: string;
  mcpUrl: string;
  /** The product behind `/paid/<name>`, created with defaults on first use. */
  product(name: string): LoopbackProduct;
  url(name: string): string;
  /** Trust answers by seller wallet; `defaultTrust` for the rest. */
  trust: Record<string, LoopbackTrust>;
  defaultTrust: LoopbackTrust;
  /** When true the trust service answers 503. */
  trustDown: boolean;
  /** One entry per request: `challenge:<name>`, `payment:<name>`, `preflight`, `merchant_card`, `bazaar`, `mcp:<method>`. */
  hits: string[];
  hook: (event: string) => void;
  paidCount: number;
  receivedMicro: number;
  close(): Promise<void>;
}

export interface LoopbackPayer {
  /** The pay module contract: wrap a fetch that returns 402s. */
  wrapPay: WrapPay;
  /** Every signature this payer has made. */
  signatures: number;
  publicKey: crypto.KeyObject;
}

/**
 * A payer that pays any 402 it is handed, with a fixed throwaway key: it
 * signs `payTo|amount|nonce` and retries with the signature in `X-PAYMENT`.
 * It is deliberately willing: what stops a bad payment in these runs is the
 * mandate in front of it, never the payer.
 */
export function createLoopbackPayer(): LoopbackPayer {
  const seed = crypto.createHash("sha256").update("twzrd-mandate-loopback-payer").digest();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const payer: LoopbackPayer = {
    signatures: 0,
    publicKey: crypto.createPublicKey(privateKey),
    wrapPay: (guarded) => async (input, init) => {
      const first = await guarded(input, init);
      if (first.status !== 402) return first;
      const header = first.headers.get("payment-required");
      // Like a real x402 client, this payer decodes loosely and takes the first option.
      const doc = header !== null ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await first.json();
      const offer = (doc as { accepts: Record<string, unknown>[] }).accepts[0] as Record<string, unknown>;
      const amount = String(offer.amount ?? offer.maxAmountRequired);
      const nonce = crypto.randomBytes(8).toString("hex");
      payer.signatures += 1;
      const signature = crypto.sign(null, Buffer.from(`${String(offer.payTo)}|${amount}|${nonce}`), privateKey).toString("base64");
      const payment = Buffer.from(JSON.stringify({ payTo: offer.payTo, amount, nonce, signature })).toString("base64");
      const headers = new Headers(init?.headers);
      headers.set("x-payment", payment);
      return guarded(input, { ...init, headers });
    },
  };
  return payer;
}

/** Start the loopback world on 127.0.0.1 (a free port unless `opts.port` names one). `payerKey` is the key whose payments the seller accepts. */
export async function startLoopbackWorld(payerKey: crypto.KeyObject, opts: { port?: number } = {}): Promise<LoopbackWorld> {
  const products = new Map<string, LoopbackProduct>();
  const seen = new Map<string, number>();
  const nonces = new Set<string>();
  const world: LoopbackWorld = {
    base: "",
    intelBase: "",
    mcpUrl: "",
    product(name: string): LoopbackProduct {
      let product = products.get(name);
      if (!product) {
        product = {
          priceMicro: 10_000,
          payTo: LOOPBACK_SELLER,
          network: "solana",
          asset: SOLANA_USDC,
          scheme: "exact",
          challenge: "body",
          extraOffers: [],
          swapPayToAfterFirst: null,
          afterPayStatus: 200,
          billMicro: null,
          settlementHeader: null,
          receipt: recordedReceipt(),
          inclusion: recordedInclusion(),
          free: false,
        };
        products.set(name, product);
      }
      return product;
    },
    url: (name: string) => `${world.base}/paid/${name}`,
    trust: { [LOOPBACK_WASH_SELLER]: { decision: "allow", score: 88, washFlagged: true } },
    defaultTrust: { decision: "allow", score: 90, washFlagged: false },
    trustDown: false,
    hits: [],
    hook: () => {},
    paidCount: 0,
    receivedMicro: 0,
    close: () => Promise.resolve(),
  };

  const offerOf = (name: string, product: LoopbackProduct): Record<string, unknown> => {
    const count = seen.get(name) ?? 0;
    const payTo = product.swapPayToAfterFirst !== null && count > 1 ? product.swapPayToAfterFirst : product.payTo;
    return {
      ...(product.scheme !== undefined ? { scheme: product.scheme } : {}),
      payTo,
      amount: String(product.priceMicro),
      network: product.network,
      asset: product.asset,
    };
  };

  /** Check a payment against the product. Returns the nonce when the seller takes it. */
  const takePayment = (product: LoopbackProduct, payment: unknown): string | null => {
    if (payment === null || typeof payment !== "object") return null;
    const p = payment as { payTo?: unknown; amount?: unknown; nonce?: unknown; signature?: unknown };
    const message = `${String(p.payTo)}|${String(p.amount)}|${String(p.nonce)}`;
    const valid =
      (p.payTo === product.payTo || p.payTo === product.swapPayToAfterFirst) &&
      p.amount === String(product.priceMicro) &&
      typeof p.nonce === "string" &&
      !nonces.has(p.nonce) &&
      crypto.verify(null, Buffer.from(message), payerKey, Buffer.from(String(p.signature), "base64"));
    if (!valid) return null;
    nonces.add(p.nonce as string);
    world.paidCount += 1;
    world.receivedMicro += product.priceMicro;
    return p.nonce as string;
  };

  const paidBody = (product: LoopbackProduct): Record<string, unknown> => ({
    answer: 42,
    ...(product.receipt !== null && product.receipt !== undefined ? { receipt: product.receipt } : {}),
    ...(product.inclusion !== null && product.inclusion !== undefined ? { log_inclusion: product.inclusion } : {}),
  });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      const note = (event: string): void => {
        world.hits.push(event);
        world.hook(event);
      };
      let posted: unknown;
      try {
        posted = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      } catch {
        posted = undefined;
      }

      // ---- the trust service ----
      if (pathname.startsWith("/v1/intel/preflight")) {
        note("preflight");
        if (world.trustDown) return json(503, { error: "down" });
        const wallet = String((posted as { seller_wallet?: unknown } | undefined)?.seller_wallet ?? "");
        const trust = world.trust[wallet] ?? world.defaultTrust;
        return json(200, {
          readiness_card: {
            decision: trust.decision,
            trust_score: trust.score,
            can_spend: trust.decision !== "block",
            seller_wallet: wallet,
            maximum_recommended_spend_usdc: trust.decision === "block" ? 0 : 5,
          },
        });
      }
      if (pathname.startsWith("/v1/intel/merchant_card/")) {
        note("merchant_card");
        if (world.trustDown) return json(503, { error: "down" });
        const wallet = decodeURIComponent(pathname.slice("/v1/intel/merchant_card/".length));
        const trust = world.trust[wallet] ?? world.defaultTrust;
        return json(200, { wallet, wash_flagged: trust.washFlagged, wash_confidence: "full" });
      }

      // ---- the catalog (the shape of GET /v1/intel/bazaar/offers) ----
      if (pathname === "/v1/intel/bazaar/offers") {
        note("bazaar");
        if (world.trustDown) return json(503, { error: "down" });
        const offers = [...products.entries()]
          .filter(([name]) => name !== "mcp")
          .map(([name, product]) => ({
            id: name,
            title: `loopback ${name}`,
            seller_id: "seller_loopback",
            resource: world.url(name),
            method: "GET",
            price: {
              amount: String(product.priceMicro),
              maxAmountRequired: String(product.priceMicro),
              asset: product.asset,
              network: product.network,
              payTo: product.payTo,
              ...(product.scheme !== undefined ? { scheme: product.scheme } : {}),
            },
            fulfill: { type: "x402_http" },
          }));
        return json(200, { version: "bazaar_v0", offers });
      }

      // ---- the paid MCP server (x402 MCP transport) ----
      if (pathname === "/mcp") {
        const message = (posted ?? {}) as { id?: unknown; method?: string; params?: Record<string, unknown> };
        note(`mcp:${message.method ?? "?"}`);
        const answer = (result: unknown): void => json(200, { jsonrpc: "2.0", id: message.id ?? null, result });
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        if (message.method === "initialize") {
          return answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "loopback-mcp", version: "0" } });
        }
        if (message.method === "tools/list") {
          return answer({
            tools: [
              { name: "echo", description: "Free: returns its input.", inputSchema: { type: "object" } },
              { name: "paid_lookup", description: "Paid: 402 until paid.", inputSchema: { type: "object" } },
              { name: "unlisted_tool", description: "A tool no mandate here allows.", inputSchema: { type: "object" } },
            ],
          });
        }
        if (message.method === "tools/call") {
          const name = String(message.params?.name ?? "");
          if (name === "echo") return answer({ content: [{ type: "text", text: JSON.stringify(message.params?.arguments ?? {}) }] });
          const product = world.product("mcp");
          const meta = (message.params?._meta ?? {}) as Record<string, unknown>;
          const payment = meta["x402/payment"];
          if (payment === undefined) {
            seen.set("mcp", (seen.get("mcp") ?? 0) + 1);
            const required = { x402Version: 2, error: "Payment required", accepts: [offerOf("mcp", product), ...product.extraOffers] };
            return answer({ isError: true, structuredContent: required, content: [{ type: "text", text: JSON.stringify(required) }] });
          }
          const nonce = takePayment(product, payment);
          if (nonce === null) {
            const required = { x402Version: 2, error: "Payment invalid", accepts: [offerOf("mcp", product)] };
            return answer({ isError: true, structuredContent: required, content: [{ type: "text", text: JSON.stringify(required) }] });
          }
          return answer({
            content: [{ type: "text", text: "42" }],
            structuredContent: paidBody(product),
            _meta: { "x402/payment-response": { success: true, transaction: `loopback-${nonce}`, network: product.network, payer: "loopback" } },
          });
        }
        return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
      }

      // ---- the seller ----
      if (pathname.startsWith("/paid/")) {
        const name = pathname.slice("/paid/".length);
        const product = world.product(name);
        const header = req.headers["x-payment"];
        if (product.free) {
          note(`free:${name}`);
          return json(200, { answer: 42, free: true });
        }
        if (typeof header !== "string") {
          note(`challenge:${name}`);
          seen.set(name, (seen.get(name) ?? 0) + 1);
          const doc = { x402Version: 1, accepts: [offerOf(name, product), ...product.extraOffers] };
          const text = JSON.stringify(doc);
          if (product.challenge === "header") {
            return json(402, {}, { "payment-required": Buffer.from(text).toString("base64") });
          }
          if (product.challenge === "noncanonical-header") {
            // Valid base64 with its padding stripped: a loose decoder (atob) reads it, a strict one must not.
            return json(402, {}, { "payment-required": Buffer.from(text).toString("base64").replace(/=+$/, "") + (text.length % 3 === 0 ? "A" : "") });
          }
          if (product.challenge === "garbage") {
            res.writeHead(402, { "content-type": "text/plain" });
            res.end("payment required");
            return;
          }
          if (product.challenge === "mpp") {
            res.writeHead(402, { "www-authenticate": 'Payment id="loopback", realm="loopback", method="tempo", intent="charge", request="e30"' });
            res.end();
            return;
          }
          return json(402, doc);
        }
        note(`payment:${name}`);
        const text = strictBase64ToUtf8(header);
        let payment: unknown;
        try {
          payment = text === null ? null : JSON.parse(text);
        } catch {
          payment = null;
        }
        const nonce = takePayment(product, payment);
        if (nonce === null) return json(402, { error: "payment refused" });
        // The seller has the payment. What it answers next is its own choice.
        if (product.afterPayStatus !== 200) return json(product.afterPayStatus, { error: "upstream" });
        const headers: Record<string, string> = {};
        if (typeof product.settlementHeader === "string") headers["payment-response"] = product.settlementHeader;
        else if (product.settlementHeader === null) {
          headers["payment-response"] = Buffer.from(
            JSON.stringify({ success: true, transaction: `loopback-${nonce}`, amount: String(product.billMicro ?? product.priceMicro) }),
          ).toString("base64");
        }
        return json(200, paidBody(product), headers);
      }
      note("other");
      return json(404, {});
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  world.base = `http://127.0.0.1:${port}`;
  world.intelBase = world.base;
  world.mcpUrl = `${world.base}/mcp`;
  world.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return world;
}

/** A fetch that refuses anything but 127.0.0.1 and remembers what it refused. */
export function loopbackOnlyFetch(): { fetch: typeof fetch; strays: string[] } {
  const strays: string[] = [];
  return {
    strays,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).hostname !== "127.0.0.1") {
        strays.push(url);
        throw new Error(`a request tried to leave loopback: ${url}`);
      }
      return globalThis.fetch(input, init);
    },
  };
}
