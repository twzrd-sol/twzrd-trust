// End-to-end harness: one paid tool call through every control between an
// agent and a seller, on loopback only.
//
//   1 agent           reads the seller's quote from its 402
//   2 tool guard      createToolGuard (agent-killswitch): kill, pause, allow-list, caps, hold
//   3 trust gate      twzrdApprovePayment (twzrd-x402-gate): seller preflight and wash check
//   4 budget          createTwzrdPolicyFetch: daily ceiling on the gate's own spend ledger
//   5 payment         a test signer pays the stub seller's 402
//   6 receipt         the returned TWZRD receipt is verified offline under the pinned key
//   7 reconciliation  both ledgers verify and agree with what the seller was paid
//
// Nothing here touches a chain or the public network: the seller, the intel
// service and the "settlement" are one HTTP server on 127.0.0.1.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  createToolGuard,
  ToolNotSentError,
} from "../agent-killswitch/dist/api.js";
import { verifyLedgerFile } from "../agent-killswitch/dist/chain.js";
import {
  createFileSpendLedger,
  createLocalDecisionSigner,
  createTwzrdPolicyFetch,
  resolveConfig,
  twzrdApprovePayment,
  TwzrdPolicyAbortError,
  TwzrdWashAbortError,
  verifyReceiptBinding,
} from "../twzrd-x402-gate/dist/index.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The reference verifier is a dependency of the Eliza plugin workspace.
const referenceVerifier = createRequire(path.join(ROOT, "eliza-plugin-source", "package.json"))(
  "twzrd-receipt-verifier",
);

/** Pinned receipt issuer key; docs/receipt-v6-spec.md publishes the same value. */
export const PINNED_RECEIPT_KEY = "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS";
/** The receipt fixture's subject: TWZRD's own seller wallet. The stub seller uses it as payTo. */
export const SELLER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const TOOL = "paid-intel";
export const MICRO = 1_000_000;
const DAY_MS = 24 * 3600 * 1000;

export const RECEIPT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "twzrd-x402-gate", "test", "fixtures", "intel-receipt-v7.json"), "utf8"),
);

/** The gate and the guard read these from the environment; a test must not inherit them. */
export function cleanEnv() {
  for (const key of Object.keys(process.env)) {
    if (/^(TWZRD_|KILLSWITCH_)/.test(key) && !key.startsWith("TWZRD_E2E_") && key !== "TWZRD_INTERNAL_CALLER") {
      delete process.env[key];
    }
  }
}

export function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twzrd-e2e-"));
  return {
    dir,
    killFile: path.join(dir, ".kill"),
    pauseFile: path.join(dir, ".pause"),
    toolLedger: path.join(dir, "spend-ledger.jsonl"),
    gateLedger: path.join(dir, "payment-spend-ledger.jsonl"),
  };
}

/** A fetch that refuses anything but 127.0.0.1 and remembers what it refused. */
export function loopbackFetch() {
  const strays = [];
  const guarded = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname !== "127.0.0.1") {
      strays.push(url);
      throw new Error(`e2e: a request left loopback: ${url}`);
    }
    return fetch(input, init);
  };
  return { fetch: guarded, strays };
}

// ---- test signer -----------------------------------------------------------

/**
 * A deterministic Ed25519 test key (fixed seed; it holds nothing). The signer
 * pays any 402 it is handed: it signs `payTo|amount|nonce` and retries with
 * the signature in `x-payment`. `signs` counts every signature.
 */
export function createTestSigner() {
  const seed = crypto.createHash("sha256").update("twzrd-e2e-test-signer").digest();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = crypto.createPublicKey(privateKey);
  const state = { signs: 0, publicKey };
  state.wrapPay = (guarded) => async (input, init) => {
    const first = await guarded(input, init);
    if (first.status !== 402) return first;
    const offer = (await first.json()).accepts[0];
    const nonce = `n${state.signs}`;
    const message = `${offer.payTo}|${offer.amount}|${nonce}`;
    state.signs += 1;
    const signature = crypto.sign(null, Buffer.from(message), privateKey).toString("base64");
    const payment = Buffer.from(JSON.stringify({ payTo: offer.payTo, amount: offer.amount, nonce, signature })).toString("base64");
    return guarded(input, { ...init, headers: { ...(init?.headers ?? {}), "x-payment": payment } });
  };
  return state;
}

// ---- stub seller + intel ---------------------------------------------------

/**
 * One loopback server that plays the seller (`/paid`: 402 with an offer, then
 * 200 for a valid signed payment) and the intel service (`/v1/intel/*`).
 * Mutable knobs let a test change the world mid-run:
 *   priceMicro, billMicro (what the seller reports it charged; null = the price),
 *   reportBill (false = no payment-response header), receipt (the body's receipt),
 *   decision ("allow" | "block"), washFlagged, hook(event) (called on every request).
 */
export async function startWorld(publicKey) {
  const world = {
    priceMicro: 10_000,
    billMicro: null,
    reportBill: true,
    receipt: RECEIPT_FIXTURE,
    decision: "allow",
    washFlagged: false,
    hook: () => {},
    hits: [],
    paidCount: 0,
    receivedMicro: 0,
    nonces: new Set(),
  };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      const header = req.headers["x-payment"];
      const event = pathname.startsWith("/v1/intel/preflight")
        ? "preflight"
        : pathname.startsWith("/v1/intel/merchant_card/")
          ? "merchant_card"
          : pathname === "/paid"
            ? typeof header === "string" ? "payment" : "challenge"
            : "other";
      world.hits.push(event);
      world.hook(event);
      if (event === "preflight") {
        const allow = world.decision === "allow";
        return json(200, {
          readiness_card: { decision: world.decision, trust_score: allow ? 90 : 5, can_spend: allow, seller_wallet: SELLER },
        });
      }
      if (event === "merchant_card") return json(200, { wash_flagged: world.washFlagged, wash_confidence: "full" });
      if (event === "challenge") {
        return json(402, { accepts: [{ payTo: SELLER, amount: String(world.priceMicro), network: "solana", asset: USDC }] });
      }
      if (event !== "payment") return json(404, {});
      let payment;
      try {
        payment = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      } catch {
        return json(400, { error: "unreadable payment" });
      }
      const message = `${payment.payTo}|${payment.amount}|${payment.nonce}`;
      const valid =
        payment.payTo === SELLER &&
        payment.amount === String(world.priceMicro) &&
        !world.nonces.has(payment.nonce) &&
        crypto.verify(null, Buffer.from(message), publicKey, Buffer.from(String(payment.signature), "base64"));
      if (!valid) return json(402, { error: "payment refused" });
      world.nonces.add(payment.nonce);
      world.paidCount += 1;
      world.receivedMicro += world.priceMicro;
      const headers = world.reportBill
        ? {
            "payment-response": Buffer.from(
              JSON.stringify({ success: true, transaction: `stub-${payment.nonce}`, amount: String(world.billMicro ?? world.priceMicro) }),
            ).toString("base64"),
          }
        : {};
      return json(200, { answer: 42, receipt: world.receipt }, headers);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  world.base = `http://127.0.0.1:${server.address().port}`;
  world.url = `${world.base}/paid`;
  world.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  return world;
}

// ---- the pipeline ----------------------------------------------------------

/** Stage 6: both verifiers must accept the receipt under the pinned key, and it must be about the seller paid. */
export function verifyReceipt(receipt, paidSeller) {
  const binding = verifyReceiptBinding(receipt, [PINNED_RECEIPT_KEY]);
  let reference = { valid: false };
  try {
    reference = referenceVerifier.verify(receipt, PINNED_RECEIPT_KEY);
  } catch {
    // a receipt the reference verifier cannot parse is not valid
  }
  const subject = receipt?.preimage?.agent_id;
  const ok = binding.ok === true && reference.valid === true && subject === paidSeller;
  return { ok, bindingOk: binding.ok === true, referenceOk: reference.valid === true, subjectMatches: subject === paidSeller };
}

/**
 * Build the buyer's side. `limits` are the tool guard's caps; `policy` is the
 * gate's spend policy. A cumulative ceiling needs the gate's ledger to count
 * against, so the pipeline refuses to be built with one and no ledger.
 */
export function createPipeline({ state, world, signer, limits, policy = {}, gateLedger = true, tripPauseOnBlockMs = 0, fetchImpl }) {
  const hasCeiling = policy.dailyCeilingUsd !== undefined || policy.monthlyCeilingUsd !== undefined;
  if (hasCeiling && !gateLedger) {
    throw new Error("e2e pipeline: a spend ceiling is configured without a spend ledger to enforce it");
  }
  const guard = createToolGuard({
    ledgerPath: state.toolLedger,
    killFilePath: state.killFile,
    pauseFilePath: state.pauseFile,
    allowedTools: [TOOL],
    ...limits,
  });
  const ledger = gateLedger ? createFileSpendLedger(state.gateLedger) : undefined;
  const decisionSigner = createLocalDecisionSigner();
  const gateConfig = resolveConfig({
    stateDir: state.dir,
    intelBase: world.base,
    fetch: fetchImpl,
    tripPauseOnBlockMs,
  });

  /** Stage 1: the agent reads the price before it asks for budget. */
  async function quote() {
    const resp = await fetchImpl(world.url);
    assert.equal(resp.status, 402, "the seller must answer an unpaid request with 402");
    // x402 v2 sellers put the offer in a PAYMENT-REQUIRED header; older ones in the body.
    const header = resp.headers.get("payment-required");
    const challenge = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await resp.json();
    const offer = challenge.accepts[0];
    return { payTo: offer.payTo, micro: Number(offer.amount), usd: Number(offer.amount) / MICRO };
  }

  /**
   * One paid tool call. Resolves to `{ result, settlement, trace }`; `trace`
   * lists the stages reached, in order. Throws what `guard.run` throws.
   */
  async function buy({ requestId } = {}) {
    const trace = ["agent"];
    const offer = await quote();
    let signedHere = 0;
    const outcome = await guard.run({ tool: TOOL, worstCaseUsd: offer.usd, requestId }, async () => {
      trace.push("tool_guard");
      // Stage 3: trust gate.
      const approval = await twzrdApprovePayment(
        { sellerWallet: offer.payTo, priceUsdc: offer.usd, chain: CHAIN, asset: USDC, resourceUrl: world.url },
        gateConfig,
      );
      if (!approval.approved) {
        throw new ToolNotSentError(`trust gate refused: ${approval.reason}`, { cause: approval });
      }
      trace.push("trust_gate");
      // Stages 4 and 5: budget authorization, then payment. One policy fetch
      // per call: it carries the pending offer of a single request.
      const countingPay = (guarded) => {
        const pay = signer.wrapPay(async (input, init) => {
          const resp = await guarded(input, init);
          if (resp.status === 402) {
            trace.push("budget");
            signedHere += 1;
          }
          return resp;
        });
        return pay;
      };
      const policyFetch = createTwzrdPolicyFetch({
        signer: decisionSigner,
        policy,
        ledger,
        fetch: fetchImpl,
        rawFetch: fetchImpl,
        wrapPay: countingPay,
        stateDir: state.dir,
        intelBase: world.base,
        topUrl: `${world.base}/top`,
        routeUrl: `${world.base}/route`,
        deliveryCapture: false,
      });
      let resp;
      try {
        resp = await policyFetch(world.url);
      } catch (err) {
        const refusedByGate = err instanceof TwzrdPolicyAbortError || err instanceof TwzrdWashAbortError;
        // Only a refusal raised before the signer was handed the 402 is "not sent".
        if (refusedByGate && signedHere === 0) {
          throw new ToolNotSentError(`payment gate refused: ${err.message}`, { cause: err });
        }
        throw err;
      }
      if (!resp.ok) throw new Error(`the seller answered ${resp.status} to a signed payment`);
      trace.push("payment");
      let billedUsd = null;
      const header = resp.headers.get("payment-response");
      if (header) {
        const settled = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
        billedUsd = Number(settled.amount) / MICRO;
      }
      // Stage 6: receipt verification. A bad receipt does not undo the payment; it is reported.
      const body = await resp.json();
      const receipt = verifyReceipt(body.receipt, offer.payTo);
      trace.push(receipt.ok ? "receipt_verified" : "receipt_rejected");
      return { result: { answer: body.answer, receipt, approval }, billedUsd };
    });
    return { ...outcome, trace };
  }

  /** Ask the trust gate directly, as another component of the same agent would. */
  const approve = (priceUsdc = 0.001) =>
    twzrdApprovePayment({ sellerWallet: SELLER, priceUsdc, chain: CHAIN, asset: USDC, resourceUrl: world.url }, gateConfig);
  return { guard, buy, quote, gateConfig, approve };
}

// ---- stage 7 ---------------------------------------------------------------

function toolLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Reconcile the three records of spend: the tool guard's ledger, the gate's
 * spend ledger and what the seller says it received. Returns the figures in
 * micro-dollars and a list of mismatches (empty when they agree).
 */
export function reconcile({ state, world, guard }) {
  const mismatches = [];
  // No file yet means nothing was recorded, which is a valid empty ledger.
  if (fs.existsSync(state.toolLedger) && !verifyLedgerFile(state.toolLedger).ok) {
    mismatches.push("the tool ledger's hash chain does not verify");
  }
  const rows = toolLines(state.toolLedger);
  const settled = rows.filter((row) => row.allowed === true && row.tool?.event === "settled");
  const toolMicro = Math.round(settled.reduce((sum, row) => sum + row.cost_usd, 0) * MICRO);

  let gateMicro = 0;
  let gateChainOk = true;
  if (fs.existsSync(state.gateLedger)) {
    try {
      // Reopening replays the file and throws on a broken chain.
      const reopened = createFileSpendLedger(state.gateLedger);
      gateMicro = Number(reopened.spentMicro(`counterparty:${SELLER}`, DAY_MS, Date.now()));
    } catch {
      gateChainOk = false;
      mismatches.push("the gate's spend ledger does not replay");
    }
    if (gateChainOk && !verifyLedgerFile(state.gateLedger).ok) mismatches.push("the gate's spend ledger chain does not verify");
  }

  const sellerMicro = world.receivedMicro;
  if (toolMicro !== gateMicro) mismatches.push(`tool ledger ${toolMicro} != gate ledger ${gateMicro}`);
  if (gateMicro !== sellerMicro) mismatches.push(`gate ledger ${gateMicro} != seller received ${sellerMicro}`);
  if (settled.length !== world.paidCount) mismatches.push(`settled lines ${settled.length} != payments ${world.paidCount}`);

  // No open holds: what the guard counts is exactly what its ledger holds.
  const allowedMicro = Math.round(rows.filter((row) => row.allowed === true).reduce((sum, row) => sum + row.cost_usd, 0) * MICRO);
  const countedMicro = Math.round(guard.spend().dayUsd * MICRO);
  if (countedMicro !== allowedMicro) mismatches.push(`guard counts ${countedMicro}, its ledger holds ${allowedMicro}: a hold is open`);

  return { ok: mismatches.length === 0, mismatches, toolMicro, gateMicro, sellerMicro, settledLines: settled.length, rows };
}
