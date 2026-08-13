#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactSvmScheme, SOLANA_MAINNET_CAIP2 } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { createRequire } from "node:module";
import bs58 from "bs58";
const VERSION = createRequire(import.meta.url)("../package.json").version;
function printHelp() {
    console.log(`twzrd-mcp-server v${VERSION}

TWZRD Agent Intelligence client with Solana x402 auto-pay.

Usage:
  twzrd-mcp-server                 Start stdio MCP server
  twzrd-mcp-server --help          Show this help
  twzrd-mcp-server --version       Print version

Free tools work with no wallet:
  preflight, merchant_card, wallet_lookup, verify_receipt

Paid tools require (opt-in):
  TWZRD_MCP_PAYMENTS_ENABLED=1
  TWZRD_WALLET_SECRET_KEY=<base58 Solana secret key>
  TWZRD_RPC_URL=<dedicated mainnet Solana RPC — required for paid tools>
  TWZRD_MAX_USDC_PER_CALL=0.05
  TWZRD_MAX_USDC_TOTAL=1.00

MCP config:
  {
    "mcpServers": {
      "twzrd": {
        "command": "npx",
        "args": ["-y", "twzrd-mcp-server"],
        "env": {
          "TWZRD_RPC_URL": "<dedicated mainnet rpc>",
          "TWZRD_WALLET_SECRET_KEY": "<base58 secret>",
          "TWZRD_MCP_PAYMENTS_ENABLED": "1"
        }
      }
    }
  }
`);
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    process.exit(0);
}
if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
}
const API_BASE = process.env.TWZRD_API_URL || "https://intel.twzrd.xyz";
// Parse a USD spend cap. A malformed value (e.g. "$0.05", "0,05" -> NaN) must
// NOT silently disable the cap: `amount > NaN` is always false, so a NaN cap
// removes all spend limits. Fall back to the safe default and warn loudly
// instead of ever arming with an unbounded cap.
function parseCap(raw, fallback, name) {
    if (raw === undefined || raw === "")
        return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        console.error(`TWZRD MCP: WARNING — ${name}=${JSON.stringify(raw)} is not a ` +
            `finite non-negative number; falling back to safe default $${fallback}. ` +
            `Spend caps are NEVER disabled on a malformed value.`);
        return fallback;
    }
    return n;
}
const MAX_PER_CALL = parseCap(process.env.TWZRD_MAX_USDC_PER_CALL, 0.05, "TWZRD_MAX_USDC_PER_CALL");
const MAX_TOTAL = parseCap(process.env.TWZRD_MAX_USDC_TOTAL, 1.0, "TWZRD_MAX_USDC_TOTAL");
// Assets we can price 1:1 against USD without an oracle, with their REAL
// on-chain decimals. The whole cap system is denominated in USD, so an amount
// can only be evaluated against a cap when its asset + true decimals are known.
// A challenge that declares different decimals for these mints is lying (or
// broken) — either way it is not evaluable, so it is refused. Mirrors the
// USD_PEGGED_ASSETS guard already shipped in twzrd-x402-gate's MPP hook.
const USD_PEGGED_ASSETS = {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC mainnet
    Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr: 6, // USDC devnet
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT mainnet
};
const PAYMENTS_ENABLED = process.env.TWZRD_MCP_PAYMENTS_ENABLED === "1";
const ALLOW_PUBLIC_RPC = process.env.TWZRD_ALLOW_PUBLIC_RPC === "1";
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const RPC_URL = process.env.TWZRD_RPC_URL || (ALLOW_PUBLIC_RPC ? PUBLIC_RPC : "");
const SECRET = process.env.TWZRD_WALLET_SECRET_KEY || "";
const RECEIPT_PUBKEY = process.env.TWZRD_RECEIPT_PUBKEY || "9V6Pn19kiUA5Rn6JpQfNduanvGt2aXGwsarosNfa2Ldf";
let spentUsdc = 0;
function selectSolanaExact(_x402Version, accepts) {
    const req = (accepts || []).find((a) => a?.scheme === "exact" && String(a?.network || "").startsWith("solana:"));
    if (!req) {
        throw new Error(`Refusing to pay: no Solana "exact" payment option in challenge (${JSON.stringify((accepts || []).map((a) => ({ scheme: a?.scheme, network: a?.network })))})`);
    }
    // Recipient must be identifiable. Never hand the signer a challenge with no
    // payTo — an unidentifiable recipient cannot be scored, capped, or trusted.
    const payTo = req.payTo ?? req.pay_to;
    if (typeof payTo !== "string" || payTo.length === 0) {
        throw new Error(`Refusing to pay: challenge has no payment recipient (payTo)`);
    }
    // Amount must be a base-unit integer. Anything else (decimals, sign, hex,
    // scientific notation) is not a base-unit charge and must not be scaled and
    // paid as if it were.
    const rawAmount = req.amount ?? req.maxAmountRequired;
    if (!/^\d+$/.test(String(rawAmount).trim())) {
        throw new Error(`Refusing to pay: charge amount is not a base-unit integer (${JSON.stringify(rawAmount)})`);
    }
    // The cap is a USD figure, so the charge is only evaluable when its asset is
    // a known USD-pegged stablecoin with known true decimals. Reject unknown
    // assets rather than trusting a merchant-supplied `decimals` — the old code
    // scaled the cap check by `req.extra.decimals`, so a challenge declaring
    // decimals:18 made a 50-USDC charge evaluate as ~5e-11 and slip under the
    // cap while `req.amount` base units were still transferred.
    const asset = req.asset;
    const trueDecimals = typeof asset === "string" ? USD_PEGGED_ASSETS[asset] : undefined;
    if (trueDecimals === undefined) {
        throw new Error(`Refusing to pay: asset ${JSON.stringify(asset)} is not a known USD-pegged ` +
            `stablecoin, so its charge cannot be evaluated against a USD spend cap. ` +
            `Supported: ${Object.keys(USD_PEGGED_ASSETS).join(", ")}`);
    }
    // If the challenge also declares decimals, it must match the mint's real
    // decimals. A mismatch is a lying/broken challenge — refuse, do not scale.
    const declaredDecimals = req.extra?.decimals;
    if (declaredDecimals !== undefined && Number(declaredDecimals) !== trueDecimals) {
        throw new Error(`Refusing to pay: challenge declares decimals=${JSON.stringify(declaredDecimals)} ` +
            `for ${asset}, which really has ${trueDecimals} decimals. Not evaluable.`);
    }
    const amountUsdc = Number(BigInt(rawAmount)) / 10 ** trueDecimals;
    if (amountUsdc > MAX_PER_CALL) {
        throw new Error(`Refusing: call price $${amountUsdc} exceeds per-call cap $${MAX_PER_CALL}`);
    }
    if (spentUsdc + amountUsdc > MAX_TOTAL) {
        throw new Error(`Refusing: would exceed session cap $${MAX_TOTAL} (spent $${spentUsdc})`);
    }
    spentUsdc += amountUsdc;
    return req;
}
let paidFetch = null;
let paymentInitError = "";
if (SECRET && PAYMENTS_ENABLED && !RPC_URL) {
    paymentInitError =
        "TWZRD_RPC_URL is required to arm paid tools. The public Solana RPC is " +
            "rate-limited and loses x402 races (stale blockhash / sponsored feePayer " +
            "between the 402 challenge and the signed retry), and a rejected settle can " +
            "still move USDC. Set TWZRD_RPC_URL to a dedicated mainnet RPC (Helius, " +
            "QuickNode, Triton, your own node). Free tools need no RPC and are unaffected. " +
            "To accept the risk anyway, set TWZRD_ALLOW_PUBLIC_RPC=1.";
    console.error(`TWZRD MCP: paid tools disabled — ${paymentInitError}`);
}
else if (SECRET && PAYMENTS_ENABLED) {
    if (RPC_URL === PUBLIC_RPC) {
        console.error("TWZRD MCP: WARNING — paid tools armed against the PUBLIC Solana RPC " +
            "(TWZRD_ALLOW_PUBLIC_RPC=1). Expect x402 settle failures under load; a " +
            "rejected settle can still move USDC. Use a dedicated RPC.");
    }
    try {
        const secretBytes = bs58.decode(SECRET);
        const signer = await createKeyPairSignerFromBytes(secretBytes);
        const scheme = new ExactSvmScheme(signer, { rpcUrl: RPC_URL });
        const client = new x402Client(selectSolanaExact);
        client.register(SOLANA_MAINNET_CAIP2, scheme);
        const httpClient = new x402HTTPClient(client);
        paidFetch = (async (input, init) => {
            const first = await fetch(input, init);
            if (first.status !== 402)
                return first;
            let challengeBody;
            try {
                const text = await first.text();
                if (text)
                    challengeBody = JSON.parse(text);
            }
            catch {
            }
            const paymentRequired = httpClient.getPaymentRequiredResponse((name) => first.headers.get(name), challengeBody);
            const payload = await client.createPaymentPayload(paymentRequired);
            const headers = httpClient.encodePaymentSignatureHeader(payload);
            const retry = new Request(input, init);
            for (const [key, value] of Object.entries(headers)) {
                retry.headers.set(key, value);
            }
            retry.headers.set("Access-Control-Expose-Headers", "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE");
            return fetch(retry);
        });
        console.error(`TWZRD MCP: auto-pay armed (payer ${signer.address}) caps $${MAX_PER_CALL}/call $${MAX_TOTAL}/session`);
    }
    catch (e) {
        paymentInitError = e instanceof Error ? e.message : String(e);
        console.error(`TWZRD MCP: payment init failed — paid tools disabled: ${paymentInitError}`);
    }
}
async function twzrdFetch(path, opts) {
    const url = `${API_BASE}${path}`;
    const method = opts?.method || "GET";
    const body = opts?.body ? JSON.stringify(opts.body) : undefined;
    const init = {
        method,
        headers: { "Content-Type": "application/json" },
        body,
    };
    if (opts?.paid) {
        if (!paidFetch) {
            const reason = !SECRET
                ? "paid tool requires TWZRD_WALLET_SECRET_KEY (base58 Solana key)"
                : !PAYMENTS_ENABLED
                    ? "paid tools are opt-in: set TWZRD_MCP_PAYMENTS_ENABLED=1 to arm them"
                    : `auto-pay unavailable: ${paymentInitError}`;
            throw new Error(reason);
        }
        return paidFetch(url, init);
    }
    return fetch(url, init);
}
async function verifyReceiptByWallet(wallet) {
    const require = createRequire(import.meta.url);
    const V = require("twzrd-receipt-verifier/verify_twzrd_receipt.js");
    const url = `https://twzrd.xyz/r/${wallet}.json`;
    const receipt = JSON.parse(await (await fetch(url)).text());
    if (!receipt.cnft_minted) {
        return JSON.stringify({ wallet, valid: false, reason: "no cNFT Receipt minted for this wallet", source: url });
    }
    const res = V.verifyCnft(receipt, V.DEFAULT_CNFT_PUBKEY, wallet);
    const anchor = receipt.anchor || {};
    return JSON.stringify({
        wallet,
        valid: !!res.valid,
        signature_valid: res.signature_valid,
        tier_at_mint: anchor.tier_at_mint,
        score_at_mint: anchor.score_at_mint,
        verify_pubkey: V.DEFAULT_CNFT_PUBKEY,
        errors: res.errors || [],
        source: url,
    });
}
function loadVerifier() {
    return createRequire(import.meta.url)("twzrd-receipt-verifier/verify_twzrd_receipt.js");
}
function extractReceipt(body) {
    if (!body || typeof body !== "object")
        return null;
    for (const k of ["receipt", "twzrd_receipt", "v6_receipt"]) {
        const inner = body[k];
        if (inner && typeof inner === "object" && ("leaf" in inner || "preimage" in inner))
            return inner;
    }
    if ("leaf" in body && "preimage" in body)
        return body;
    return null;
}
function attachOfflineVerification(trustText) {
    let body;
    try {
        body = JSON.parse(trustText);
    }
    catch {
        return trustText;
    }
    const receipt = extractReceipt(body);
    if (!receipt) {
        body.offline_receipt_verification = { checked: false, reason: "no V6 receipt in response" };
        return JSON.stringify(body);
    }
    let res;
    try {
        res = loadVerifier().verify(receipt, RECEIPT_PUBKEY);
    }
    catch (e) {
        body.offline_receipt_verification = { checked: false, reason: `verifier error: ${e instanceof Error ? e.message : String(e)}` };
        return JSON.stringify(body);
    }
    const block = {
        checked: true,
        valid: !!res.valid,
        leaf_valid: !!res.leaf_valid,
        signature_valid: !!res.signature_valid,
        pinned_pubkey: RECEIPT_PUBKEY,
        verified_by: "twzrd-receipt-verifier",
        errors: res.errors || [],
    };
    if (!block.valid) {
        console.error(`TWZRD MCP DOGFOOD ALERT: paid V6 receipt FAILED offline verify — ${JSON.stringify(block.errors)}`);
    }
    body.offline_receipt_verification = block;
    return JSON.stringify(body);
}
async function authorizeSpend(wallet, provider, amountMicro) {
    const baseUrl = process.env.TWZRD_API_URL || "https://api.twzrd.xyz";
    try {
        const resp = await fetch(`${baseUrl}/v1/spend/authorize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wallet, provider, amount_micro: amountMicro }),
        });
        if (!resp.ok)
            return;
        const data = await resp.json();
        if (data.authorized === false) {
            throw new Error(`TWZRD spend denied: ${data.reason}`);
        }
    }
    catch (e) {
        if (e instanceof Error && e.message.startsWith("TWZRD spend denied"))
            throw e;
    }
}
const TOOLS = [
    { name: "preflight", description: "FREE pre-payment check. readiness_card with allow/warn/block + trust_score. No payment.", inputSchema: { type: "object", properties: { seller_wallet: { type: "string" }, resource_name: { type: "string" }, price_usdc: { type: "number" } }, required: ["seller_wallet"] } },
    { name: "merchant_card", description: "FREE: seller graph card for a payTo wallet or resource id. wash_flagged=true -> do not pay (locked buyer sequence step 2). No payment.", inputSchema: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] } },
    { name: "wallet_lookup", description: "FREE: facilitators + counterparty breadth for a Solana wallet.", inputSchema: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] } },
    { name: "verify_receipt", description: "FREE: independently verify a wallet's cNFT Receipt offline (Ed25519 vs the genesis authority 2ELSDx). No trust in any TWZRD server.", inputSchema: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] } },
    { name: "quick_trust", description: "PAID $0.001 (auto-pay, Solana x402): quick tier+score for a Solana wallet.", inputSchema: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] } },
    { name: "full_trust", description: "PAID $0.05 (auto-pay, Solana x402): full trust intel + signed V6 receipt.", inputSchema: { type: "object", properties: { wallet: { type: "string" }, seller_wallet: { type: "string" } }, required: ["wallet"] } },
];
const server = new Server({ name: "twzrd-mcp-server", version: VERSION }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args || {});
    async function api(path, opts) {
        const r = await twzrdFetch(path, opts);
        const t = await r.text();
        if (!r.ok)
            throw new Error(`TWZRD API ${r.status}: ${t.slice(0, 200)}`);
        return t;
    }
    switch (name) {
        case "quick_trust":
            await authorizeSpend(String(a.wallet), "/v1/intel/quick", 1000);
            return { content: [{ type: "text", text: await api(`/v1/intel/quick/${String(a.wallet)}`, { paid: true }) }] };
        case "full_trust": {
            await authorizeSpend(String(a.wallet), "/v1/intel/trust", 50000);
            const trustText = await api(`/v1/intel/trust/${String(a.wallet)}${a.seller_wallet ? `?seller_wallet=${a.seller_wallet}` : ""}`, { paid: true });
            return { content: [{ type: "text", text: attachOfflineVerification(trustText) }] };
        }
        case "preflight": return { content: [{ type: "text", text: await api("/v1/intel/preflight", { method: "POST", body: { seller_wallet: a.seller_wallet, resource_name: a.resource_name || "MCP", price_usdc: a.price_usdc ?? 0.05 } }) }] };
        case "merchant_card": return { content: [{ type: "text", text: await api(`/v1/intel/merchant_card/${String(a.wallet)}`) }] };
        case "verify_receipt": return { content: [{ type: "text", text: await verifyReceiptByWallet(String(a.wallet)) }] };
        case "wallet_lookup": return { content: [{ type: "text", text: await api(`/v1/intel/get_facilitator_footprint?wallet=${String(a.wallet)}`) }] };
        default: throw new Error(`Unknown tool: ${name}`);
    }
});
function selfTestVerifier() {
    try {
        const V = loadVerifier();
        const pre = { domain: "TWZRD:AO_REPUTATION_RECEIPT_V6", agent_id: "selftest", score: 1, confidence_bps: 1, timestamp_unix: 1, payer: "selftest", settlement_tx: "selftest" };
        const leaf = V.recomputeLeaf(pre);
        const leafOk = !!leaf && leaf.length === 32;
        const bad = V.verify({ preimage: pre, leaf: "0x" + "00".repeat(32), signature: "1".repeat(64), signing_pubkey: RECEIPT_PUBKEY }, RECEIPT_PUBKEY);
        if (leafOk && !bad.valid) {
            console.error("TWZRD MCP: receipt verifier self-test PASS (leaf recomputed, bad receipt rejected)");
        }
        else {
            console.error(`TWZRD MCP: receipt verifier self-test FAILED (leafOk=${leafOk} badRejected=${!bad.valid}) — offline verification may be broken`);
        }
    }
    catch (e) {
        console.error(`TWZRD MCP: receipt verifier self-test ERROR — ${e instanceof Error ? e.message : String(e)}`);
    }
}
selfTestVerifier();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`TWZRD MCP (Solana x402) — paid=${paidFetch ? "enabled" : "disabled"} caps: $${MAX_PER_CALL}/call $${MAX_TOTAL}/session`);
