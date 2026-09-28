/**
 * Pre-sign plumbing, end to end through the published entry point:
 *
 *   HTTP 402 (PAYMENT-REQUIRED, x402 v2 accepts[])
 *     -> createGuardedX402Fetch (local recipient / price / budget rules)
 *     -> TWZRD pre-sign evaluator -> POST /v1/intel/preflight (stubbed here, recorded)
 *     -> real @x402/svm ExactSvmScheme -> counting TransactionPartialSigner
 *
 * The signer count is taken where a signature would actually be produced, not at
 * a hook, so `signerInvocations === 0` proves the refusal happened before signing.
 * Devnet USDC on the devnet CAIP-2 id at $0.001 keeps @x402/core's own default
 * spend controls out of the way, so each assertion measures the TWZRD layer.
 * Intel is stubbed at its HTTP boundary: the stub records the exact request the
 * gate sent and returns the readiness card each scenario needs. No egress.
 *
 * Run: npx tsx test/preflight-plumbing.test.ts   (PLUMBING_VERBOSE=1 prints payloads)
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getMintEncoder } from "@solana-program/token-2022";
import { getAddressDecoder, getBase64Decoder, none } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";

import { createGuardedX402Fetch } from "../src/guarded-x402-fetch.js";

const VERBOSE = process.env.PLUMBING_VERBOSE === "1";
const addr = (fill: number) => getAddressDecoder().decode(new Uint8Array(32).fill(fill));
const BUYER = addr(1);
const SELLER_CLEAN = addr(3);
const SELLER_WASH = addr(5);
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const AMOUNT = "1000"; // $0.001
const FEE_PAYER = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";

const MINT_ACCOUNT_B64 = getBase64Decoder().decode(
  getMintEncoder().encode({
    mintAuthority: none(),
    supply: 0n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: none(),
    extensions: none(),
  }),
);

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");

/** One loopback server: the paid merchant (402, then 200 on PAYMENT-SIGNATURE) and the Solana RPC. */
async function startOrigin(payTo: string) {
  let signedRequests = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
      if (req.method === "POST" && req.url === "/rpc") {
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
        const result =
          rpc.method === "getAccountInfo"
            ? {
                context: { apiVersion: "offline-fixture", slot: 1 },
                value: { data: [MINT_ACCOUNT_B64, "base64"], executable: false, lamports: 1_000_000, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 },
              }
            : null;
        return json(200, { jsonrpc: "2.0", id: rpc.id, result });
      }
      if (req.url === "/paid") {
        if (!req.headers["payment-signature"]) {
          const required = {
            x402Version: 2,
            resource: { url: `${origin}/paid` },
            accepts: [
              {
                scheme: "exact",
                network: NETWORK,
                asset: DEVNET_USDC,
                amount: AMOUNT,
                payTo,
                maxTimeoutSeconds: 60,
                extra: { feePayer: FEE_PAYER, recentBlockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: "100" },
              },
            ],
          };
          return json(402, required, { "PAYMENT-REQUIRED": b64(required) });
        }
        signedRequests += 1;
        return json(200, { ok: true }, { "PAYMENT-RESPONSE": b64({ success: true, transaction: "offline-fixture", network: NETWORK }) });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, signedRequests: () => signedRequests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

type IntelCall = { url: string; body: Record<string, unknown> };
type Decision = { approved: boolean; reason: string; verdict?: string; payTo?: string; network?: string; amountMicro?: string };

/** Stubbed intel: records every request, answers with the scenario's readiness card. */
function recordingIntel(card: Record<string, unknown>, calls: IntelCall[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    // Live intel serves the merchant card flat and the preflight card under readiness_card.
    const payload = /\/v1\/intel\/merchant_card\//.test(String(url)) ? card : { readiness_card: card };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

async function run(opts: {
  payTo: string;
  card: Record<string, unknown>;
  twzrd?: Record<string, unknown>;
  maxPricePerCall?: string;
}) {
  const origin = await startOrigin(opts.payTo);
  const intelCalls: IntelCall[] = [];
  const decisions: Decision[] = [];
  let signerInvocations = 0;
  const countingSigner = {
    address: BUYER,
    async signTransactions(txs: ReadonlyArray<{ messageBytes: Uint8Array }>) {
      signerInvocations += 1;
      return txs.map(() => ({ [BUYER]: new Uint8Array(64) }));
    },
  };
  const client = new x402Client();
  client.register(NETWORK as never, new ExactSvmScheme(countingSigner as never, { rpcUrl: `${origin.origin}/rpc` }));
  const paidFetch = createGuardedX402Fetch({
    client: client as never,
    fetch,
    maxPricePerCall: opts.maxPricePerCall,
    twzrd: {
      fetch: recordingIntel(opts.card, intelCalls),
      onDecision: (d: unknown) => decisions.push(d as Decision),
      ...(opts.twzrd ?? {}),
    } as never,
  });
  let status: number | null = null;
  let error: string | null = null;
  try {
    status = (await paidFetch(`${origin.origin}/paid`)).status;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const merchantPaid = origin.signedRequests();
  await origin.close();
  return { origin: origin.origin, intelCalls, decisions, signerInvocations, merchantPaid, status, error };
}

function show(label: string, r: Awaited<ReturnType<typeof run>>) {
  if (!VERBOSE) return;
  console.log(`\n=== ${label} ===`);
  console.log("intel requests:", JSON.stringify(r.intelCalls, null, 1));
  console.log("decisions:", JSON.stringify(r.decisions));
  console.log({ signerInvocations: r.signerInvocations, merchantPaid: r.merchantPaid, status: r.status, error: r.error });
}

/** The preflight request must be built from accepts[0] of the challenge, not from headers. */
function assertWire(r: Awaited<ReturnType<typeof run>>, payTo: string) {
  const pre = r.intelCalls.filter((c) => /\/v1\/intel\/preflight$/.test(c.url));
  assert.equal(pre.length, 1, `exactly one preflight per payment attempt: ${JSON.stringify(r.intelCalls.map((c) => c.url))}`);
  const body = pre[0].body;
  assert.equal(body.seller_wallet, payTo, "seller_wallet comes from accepts[0].payTo");
  assert.equal(body.chain, NETWORK, "chain comes from accepts[0].network");
  assert.equal(body.resource_url, `${r.origin}/paid`, "resource_url comes from the challenge resource");
  assert.equal(body.price_usdc, 0.001, "price comes from accepts[0].amount (1000 atomic USDC)");
  // Any other intel read must be about the same payTo (the merchant card), never another wallet.
  for (const c of r.intelCalls) if (!/\/v1\/intel\/preflight$/.test(c.url)) assert.ok(c.url.includes(payTo), c.url);
}

async function main() {
  // A. Clean seller: intel allows, the signer runs exactly once, the merchant is paid.
  {
    const r = await run({ payTo: SELLER_CLEAN, card: { decision: "allow", can_spend: true, trust_score: 90, seller_wallet: SELLER_CLEAN, wash_flagged: false } });
    show("A clean seller", r);
    assertWire(r, SELLER_CLEAN);
    assert.equal(r.decisions[0]?.approved, true, `approved: ${JSON.stringify(r.decisions)}`);
    assert.equal(r.signerInvocations, 1, "an approved payment must be signed exactly once");
    assert.equal(r.merchantPaid, 1);
    assert.equal(r.status, 200);
  }

  // B. Wash-flagged seller that intel blocks: refused before the signer, with gate defaults.
  {
    const r = await run({ payTo: SELLER_WASH, card: { decision: "block", can_spend: false, trust_score: 12, seller_wallet: SELLER_WASH, wash_flagged: true, reason_codes: ["WASH_FLAGGED"] } });
    show("B wash-flagged, intel block", r);
    assertWire(r, SELLER_WASH);
    assert.equal(r.decisions[0]?.approved, false);
    assert.match(String(r.error), /\[twzrd\]/, "the refusal names TWZRD");
    assert.equal(r.signerInvocations, 0, "CRITICAL: a blocked payment must never reach the signer");
    assert.equal(r.merchantPaid, 0);
  }

  // B2. Wash-flagged but intel says warn: refused only when the caller opts into refuseWashFlagged.
  {
    const card = { decision: "warn", can_spend: true, trust_score: 60, seller_wallet: SELLER_WASH, wash_flagged: true, recommended_cap_usdc: 1 };
    const r = await run({ payTo: SELLER_WASH, card, twzrd: { refuseWashFlagged: true } });
    show("B2 wash-flagged warn, refuseWashFlagged: true", r);
    assertWire(r, SELLER_WASH);
    assert.equal(r.decisions[0]?.approved, false, `decisions: ${JSON.stringify(r.decisions)}`);
    assert.equal(r.signerInvocations, 0, "CRITICAL: an opted-in wash refusal must never reach the signer");
  }

  // C. No counterparty: a challenge with no payTo is refused locally; intel is not asked and nothing is signed.
  {
    const r = await run({ payTo: "", card: { decision: "block", can_spend: false, trust_score: null, null_reason: "no_subject", wash_flagged: null } });
    show("C no counterparty (empty payTo)", r);
    assert.equal(r.intelCalls.length, 0, "no seller to ask about: intel must not be called");
    assert.notEqual(r.error, null);
    assert.equal(r.signerInvocations, 0, "CRITICAL: a challenge naming no recipient must never reach the signer");
    assert.equal(r.merchantPaid, 0);
  }

  // C2. Intel's own no_subject card (the shape live intel serves since #3011) is honored as a block.
  {
    const card = { decision: "block", can_spend: false, trust_score: null, score: null, null_reason: "no_subject", wash_flagged: null, reason_codes: ["PREFLIGHT_BLOCK", "NO_COUNTERPARTY"] };
    const r = await run({ payTo: SELLER_CLEAN, card });
    show("C2 intel no_subject card", r);
    assertWire(r, SELLER_CLEAN);
    assert.equal(r.decisions[0]?.approved, false);
    assert.equal(r.signerInvocations, 0, "CRITICAL: a no_subject block must never reach the signer");
  }

  // E. A seller intel never evaluated (the card live intel serves for a new wallet):
  //    0.11.0 follows the card's cap. Within it the payment signs once; above it,
  //    with no cap, or with refuseUnevaluated: true, nothing is signed.
  {
    const unknown = (cap?: number) => ({
      decision: "warn",
      can_spend: true,
      trust_score: 45,
      score: null,
      null_reason: "unknown_subject",
      seller_wallet: SELLER_CLEAN,
      ...(cap === undefined ? {} : { recommended_cap_usdc: cap }),
    });

    const within = await run({ payTo: SELLER_CLEAN, card: unknown(0.01) });
    show("E1 unknown seller, $0.001 within a $0.01 cap", within);
    assertWire(within, SELLER_CLEAN);
    assert.equal(within.decisions[0]?.approved, true, `decisions: ${JSON.stringify(within.decisions)}`);
    assert.match(String(within.decisions[0]?.reason), /twzrd_unevaluated_within_cap_0\.001_le_0\.01/);
    assert.equal(within.signerInvocations, 1, "an unevaluated seller within its cap is signed exactly once");
    assert.equal(within.merchantPaid, 1);
    assert.equal(within.status, 200);

    const over = await run({ payTo: SELLER_CLEAN, card: unknown(0.0005) });
    show("E2 unknown seller, $0.001 over a $0.0005 cap", over);
    assert.equal(over.decisions[0]?.approved, false);
    assert.match(String(over.decisions[0]?.reason), /twzrd_unevaluated_over_cap_/);
    assert.equal(over.signerInvocations, 0, "CRITICAL: an unevaluated seller over its cap must never reach the signer");

    const noCap = await run({ payTo: SELLER_CLEAN, card: unknown() });
    show("E3 unknown seller, card carries no cap", noCap);
    assert.equal(noCap.decisions[0]?.approved, false);
    assert.match(String(noCap.decisions[0]?.reason), /twzrd_unevaluated_no_cap_unknown_subject/);
    assert.equal(noCap.signerInvocations, 0, "CRITICAL: an unevaluated seller with no cap must never reach the signer");

    const strict = await run({ payTo: SELLER_CLEAN, card: unknown(0.01), twzrd: { refuseUnevaluated: true } });
    show("E4 unknown seller, refuseUnevaluated: true", strict);
    assert.equal(strict.decisions[0]?.approved, false);
    assert.match(String(strict.decisions[0]?.reason), /twzrd_unevaluated_subject_unknown_subject/);
    assert.equal(strict.signerInvocations, 0, "CRITICAL: refuseUnevaluated must refuse before the signer");
  }

  // D. Bypass: twzrd.disabled skips the intel call entirely but local caps still bind.
  {
    const refused = await run({ payTo: SELLER_CLEAN, card: {}, twzrd: { disabled: true }, maxPricePerCall: "0.0005" });
    show("D1 twzrd disabled, $0.001 over a $0.0005 cap", refused);
    assert.equal(refused.intelCalls.length, 0, "disabled: no intel request");
    assert.match(String(refused.error), /price_cap_exceeded/);
    assert.equal(refused.signerInvocations, 0, "CRITICAL: the local cap still blocks with TWZRD disabled");

    const allowed = await run({ payTo: SELLER_CLEAN, card: {}, twzrd: { disabled: true }, maxPricePerCall: "0.01" });
    show("D2 twzrd disabled, under the cap", allowed);
    assert.equal(allowed.intelCalls.length, 0, "disabled: no intel request");
    assert.equal(allowed.signerInvocations, 1);
    assert.equal(allowed.status, 200);
  }

  // D3. The env switch TWZRD_GATE_ENABLED=false is the same bypass: no intel call, caps still bind.
  {
    process.env.TWZRD_GATE_ENABLED = "false";
    try {
      const r = await run({ payTo: SELLER_CLEAN, card: {}, maxPricePerCall: "0.0005" });
      show("D3 TWZRD_GATE_ENABLED=false over the cap", r);
      assert.equal(r.intelCalls.length, 0, "env-disabled: no intel request");
      assert.match(String(r.error), /price_cap_exceeded/);
      assert.equal(r.signerInvocations, 0);
    } finally {
      delete process.env.TWZRD_GATE_ENABLED;
    }
  }

  console.log("preflight-plumbing: OK (A and E1 sign once; B, B2, C, C2, E2-E4 and D1 refuse with 0 signer calls; D bypasses intel but keeps caps)");
}

main().catch((e) => {
  console.error("preflight-plumbing FAILED:", e);
  process.exit(1);
});
