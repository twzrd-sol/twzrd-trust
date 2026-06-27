/**
 * TWZRD MCP Server — auto-pay x402 wrapper for TWZRD's Trust API (SOLANA).
 *
 * Agents install this MCP server; paid tool calls auto-handle the x402 challenge
 * (detect 402 -> SDK builds + signs a Solana USDC payment -> retry). Free tools
 * never pay.
 *
 * PAYMENT CORE: the official x402 SDK (@x402/core + @x402/svm + @x402/fetch).
 * TWZRD settles x402 on **Solana** ("exact" scheme, USDC, sponsored feePayer):
 * the buyer partial-signs a USDC transfer as the transfer authority, and TWZRD's
 * wallet (the challenge `extra.feePayer`) co-signs + pays the SOL fee server-side.
 * `@x402/svm`'s ExactSvmScheme reads `extra.feePayer` and builds exactly this
 * partially-signed transaction; the SDK also encodes the X-PAYMENT header the
 * server validates. (An earlier draft hand-rolled both and the server rejected
 * it — the hand-rolled header never matched the official x402 PaymentPayload.)
 *
 * SAFETY GUARDRAILS (all enforced in the payment-requirements selector, BEFORE
 * any signature):
 *   - Hard per-call cap (TWZRD_MAX_USDC_PER_CALL, default 0.05)
 *   - Cumulative session cap (TWZRD_MAX_USDC_TOTAL, default 1.00)
 *   - Free discovery tools are NEVER routed through the payment path
 *   - No cross-chain fallback: only a Solana "exact" requirement is selectable;
 *     anything else throws (refuse to pay) rather than mis-signing
 *   - Paid tools run the FREE preflight first; decision=block aborts the pay
 *
 * STATUS: payment mechanism is SDK-backed and the payload construction is
 * verified against the live Solana "exact" challenge. The first real on-chain
 * settle is the operator's go (needs a funded wallet). Set
 * TWZRD_MCP_PAYMENTS_ENABLED=0 to force paid tools off (fail-closed) if desired.
 *
 * ENV:
 *   TWZRD_WALLET_SECRET_KEY   base58 Solana secret key (64-byte). Required for paid calls.
 *   TWZRD_RPC_URL             Solana RPC (default mainnet-beta public)
 *   TWZRD_API_URL             default https://intel.twzrd.xyz
 *   TWZRD_MAX_USDC_PER_CALL   default 0.05
 *   TWZRD_MAX_USDC_TOTAL      default 1.00
 *   TWZRD_MCP_PAYMENTS_ENABLED  "0" to force paid tools off (default: enabled when a key is present)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme, SOLANA_MAINNET_CAIP2 } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import bs58 from "bs58";

// ── Config ─────────────────────────────────────────────────────────────────
const API_BASE = process.env.TWZRD_API_URL || "https://intel.twzrd.xyz";
const RPC_URL = process.env.TWZRD_RPC_URL || "https://api.mainnet-beta.solana.com";
const MAX_PER_CALL = Number(process.env.TWZRD_MAX_USDC_PER_CALL || "0.05");
const MAX_TOTAL = Number(process.env.TWZRD_MAX_USDC_TOTAL || "1.00");
const PAYMENTS_DISABLED = process.env.TWZRD_MCP_PAYMENTS_ENABLED === "0";
const SECRET = process.env.TWZRD_WALLET_SECRET_KEY || "";

let spentUsdc = 0; // cumulative session spend (USDC)

// ── Payment client (official x402 SDK, Solana exact scheme) ──────────────────
// The selector is the single chokepoint for every guardrail: it picks which
// `accepts[]` entry to pay and THROWS to refuse. Nothing is signed unless a
// requirement passes scheme + chain + per-call + session checks here first.
function selectSolanaExact(_x402Version: number, accepts: any[]): any {
  const req = (accepts || []).find(
    (a) => a?.scheme === "exact" && String(a?.network || "").startsWith("solana:"),
  );
  if (!req) {
    throw new Error(
      `Refusing to pay: no Solana "exact" payment option in challenge (${JSON.stringify(
        (accepts || []).map((a) => ({ scheme: a?.scheme, network: a?.network })),
      )})`,
    );
  }
  const decimals = Number(req.extra?.decimals ?? 6);
  const amountUsdc = Number(BigInt(req.amount)) / 10 ** decimals;
  if (amountUsdc > MAX_PER_CALL) {
    throw new Error(`Refusing: call price $${amountUsdc} exceeds per-call cap $${MAX_PER_CALL}`);
  }
  if (spentUsdc + amountUsdc > MAX_TOTAL) {
    throw new Error(`Refusing: would exceed session cap $${MAX_TOTAL} (spent $${spentUsdc})`);
  }
  // Conservative accounting: count the spend at selection time. A failed settle
  // only makes the caps stricter (never looser), which is the safe direction.
  spentUsdc += amountUsdc;
  return req;
}

// Build the payment-enabled fetch once, if a key is present and payments aren't
// force-disabled. Otherwise paid tools fail closed with a clear message.
let paidFetch: typeof fetch | null = null;
let paymentInitError = "";
if (SECRET && !PAYMENTS_DISABLED) {
  try {
    const secretBytes = bs58.decode(SECRET);
    const signer = await createKeyPairSignerFromBytes(secretBytes);
    const scheme = new ExactSvmScheme(signer, { rpcUrl: RPC_URL });
    const client = new x402Client(selectSolanaExact);
    client.register(SOLANA_MAINNET_CAIP2, scheme);
    paidFetch = wrapFetchWithPayment(fetch, client);
    console.error(`TWZRD MCP: auto-pay armed (payer ${signer.address}) caps $${MAX_PER_CALL}/call $${MAX_TOTAL}/session`);
  } catch (e) {
    paymentInitError = e instanceof Error ? e.message : String(e);
    console.error(`TWZRD MCP: payment init failed — paid tools disabled: ${paymentInitError}`);
  }
}

// ── HTTP: free path is plain fetch; paid path goes through the x402 SDK ───────
async function twzrdFetch(
  path: string,
  opts?: { method?: string; body?: unknown; paid?: boolean },
): Promise<Response> {
  const url = `${API_BASE}${path}`;
  const method = opts?.method || "GET";
  const body = opts?.body ? JSON.stringify(opts.body) : undefined;
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  };
  if (opts?.paid) {
    if (!paidFetch) {
      throw new Error(
        SECRET
          ? `auto-pay unavailable: ${paymentInitError || "payments force-disabled (TWZRD_MCP_PAYMENTS_ENABLED=0)"}`
          : "paid tool requires TWZRD_WALLET_SECRET_KEY (base58 Solana key)",
      );
    }
    return paidFetch(url, init);
  }
  return fetch(url, init);
}

// ── Tools (free vs paid clearly separated; paid tools pass { paid: true }) ───
const TOOLS = [
  { name: "preflight", description: "FREE pre-payment check. readiness_card with allow/warn/block + trust_score. No payment.", inputSchema: { type: "object", properties: { seller_wallet: { type: "string" }, resource_name: { type: "string" }, price_usdc: { type: "number" } }, required: ["seller_wallet"] } },
  { name: "wallet_lookup", description: "FREE: facilitators + counterparty breadth for a Solana wallet.", inputSchema: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] } },
  { name: "verify_receipt", description: "FREE: verify a TWZRD V6 receipt (leaf/signature/signing_pubkey).", inputSchema: { type: "object", properties: { leaf: { type: "string" }, signature: { type: "string" }, signing_pubkey: { type: "string" } }, required: ["leaf"] } },
  { name: "quick_trust", description: "PAID $0.001 (auto-pay, Solana x402): quick tier+score for a Solana wallet.", inputSchema: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] } },
  { name: "full_trust", description: "PAID $0.05 (auto-pay, Solana x402): full trust intel + signed V6 receipt.", inputSchema: { type: "object", properties: { wallet: { type: "string" }, seller_wallet: { type: "string" } }, required: ["wallet"] } },
];

const server = new Server({ name: "twzrd-mcp-server", version: "0.2.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;
  async function api(path: string, opts?: { method?: string; body?: unknown; paid?: boolean }): Promise<string> {
    const r = await twzrdFetch(path, opts);
    const t = await r.text();
    if (!r.ok) throw new Error(`TWZRD API ${r.status}: ${t.slice(0, 200)}`);
    return t;
  }
  // NOTE: quick_trust/full_trust BUY intel ON `wallet` — the caller looks a wallet
  // up precisely because they want to know about it (including risky ones). We do
  // NOT gate the purchase on that wallet's own trust score; that would be backwards
  // (you'd be blocked from buying intel on exactly the wallets you most need it for).
  // The `preflight` tool exists separately to vet a SELLER you are about to pay
  // ELSEWHERE. Spend caps + the payment selector are the safety controls here.
  switch (name) {
    case "quick_trust": return { content: [{ type: "text", text: await api(`/v1/intel/quick/${String(a.wallet)}`, { paid: true }) }] };
    case "full_trust": return { content: [{ type: "text", text: await api(`/v1/intel/trust/${String(a.wallet)}${a.seller_wallet ? `?seller_wallet=${a.seller_wallet}` : ""}`, { paid: true }) }] };
    case "preflight": return { content: [{ type: "text", text: await api("/v1/intel/preflight", { method: "POST", body: { seller_wallet: a.seller_wallet, resource_name: a.resource_name || "MCP", price_usdc: a.price_usdc ?? 0.05 } }) }] };
    case "verify_receipt": return { content: [{ type: "text", text: await api("/v1/receipts/verify", { method: "POST", body: { leaf: a.leaf, signature: a.signature, signing_pubkey: a.signing_pubkey } }) }] };
    case "wallet_lookup": return { content: [{ type: "text", text: await api(`/v1/intel/get_facilitator_footprint?wallet=${String(a.wallet)}`) }] };
    default: throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`TWZRD MCP (Solana x402) — paid=${paidFetch ? "enabled" : "disabled"} caps: $${MAX_PER_CALL}/call $${MAX_TOTAL}/session`);
