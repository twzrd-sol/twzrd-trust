#!/usr/bin/env -S npx tsx
/**
 * Live dogfood: official @x402/fetch + ExactSvmScheme + installTwzrdX402ClientHook.
 *
 * Proves Path E binding on a real Solana USDC settlement:
 *   402 → client selects requirements → onBeforePaymentCreation (TWZRD) →
 *   same selectedRequirements signed → one settlement ≤ $0.001
 *
 * Default target: intel /quick (0.001 USDC exact).
 *
 * Env:
 *   SVM_KEYPAIR_PATH  — JSON wallet with privateKey base58 seed (default: ~/.agentcash/solana-wallet.json)
 *   DOGFOOD_URL       — paid resource (default: intel quick on a known pubkey)
 *   TWZRD_GATE_ON_CAN_SPEND — set true to exercise hard can_spend block (no settle)
 *
 * Run:
 *   npx tsx examples/official-x402-dogfood.ts
 *   npx tsx examples/official-x402-dogfood.ts --block   # gateOnCanSpend=true, expect abort
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";

import { installTwzrdX402ClientHook } from "../src/x402-client-hook.js";

type LogEvent = { t: number; event: string; detail?: Record<string, unknown> };

const events: LogEvent[] = [];
const t0 = Date.now();
function log(event: string, detail?: Record<string, unknown>) {
  const row = { t: Date.now() - t0, event, detail };
  events.push(row);
  console.log(`[dogfood +${row.t}ms] ${event}`, detail ? JSON.stringify(detail) : "");
}

const MAX_AMOUNT_MICRO = 1000n; // hard cap: $0.001 USDC
/** Corpus top agent — has a quick/trust score (JUP mint has no score → 422). */
const DEFAULT_URL =
  process.env.DOGFOOD_URL ??
  "https://intel.twzrd.xyz/v1/intel/quick/35ramn32ufUApgbcgopVe5muHqNftHN1L3BfBNsDzGsx";

const BLOCK_MODE =
  process.argv.includes("--block") ||
  process.env.TWZRD_GATE_ON_CAN_SPEND === "true" ||
  process.env.TWZRD_GATE_ON_CAN_SPEND === "1";

function loadWalletPath(): string {
  return (
    process.env.SVM_KEYPAIR_PATH ??
    join(homedir(), ".agentcash", "solana-wallet.json")
  );
}

async function loadSvmSigner() {
  const path = loadWalletPath();
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    privateKey?: string;
    address?: string;
    secretKey?: number[];
  };
  if (raw.privateKey) {
    const seed = base58.decode(raw.privateKey);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    return { signer, path, expected: raw.address };
  }
  throw new Error(`Unsupported wallet format at ${path} (need privateKey base58 seed)`);
}

async function main() {
  console.log("official-x402-dogfood");
  console.log("mode", BLOCK_MODE ? "BLOCK (gateOnCanSpend=true)" : "ALLOW (decision-only default)");
  console.log("url", DEFAULT_URL);
  console.log("max_amount_micro", MAX_AMOUNT_MICRO.toString());

  const { signer, path, expected } = await loadSvmSigner();
  log("wallet_loaded", {
    path,
    address: signer.address,
    expected_match: expected ? expected === signer.address : null,
  });

  const client = new x402Client();
  client.register("solana:*", new ExactSvmScheme(signer));
  log("scheme_registered", { network: "solana:*" });

  // Hard amount cap before TWZRD (defense in depth for dogfood).
  // Official x402Client runs beforePaymentCreation hooks in registration
  // order and short-circuits on first abort — proven offline by
  // test/x402-official-compat.test.ts multi-hook cases.
  client.onBeforePaymentCreation(async (context) => {
    const req = context.selectedRequirements ?? {};
    const amount = BigInt(String(req.amount ?? req.maxAmountRequired ?? "0"));
    log("amount_cap_check", {
      amount: amount.toString(),
      payTo: req.payTo ?? req.pay_to,
      network: req.network,
    });
    if (amount > MAX_AMOUNT_MICRO) {
      return {
        abort: true,
        reason: `dogfood hard cap: amount ${amount} > ${MAX_AMOUNT_MICRO}`,
      };
    }
  });

  let decisionCount = 0;
  installTwzrdX402ClientHook(client, {
    gateOnCanSpend: BLOCK_MODE,
    preflightMinScore: 40,
    refuseWashFlagged: true,
    onDecision: (d) => {
      decisionCount += 1;
      log("twzrd_onBeforePaymentCreation_decision", {
        ...d,
        decision_n: decisionCount,
      });
    },
  });
  log("twzrd_hook_installed", { gateOnCanSpend: BLOCK_MODE });

  // Also log after payload creation (post-approval, pre/post sign path)
  client.onAfterPaymentCreation(async (context) => {
    log("after_payment_creation", {
      payTo: context.selectedRequirements?.payTo,
      amount: context.selectedRequirements?.amount,
      network: context.selectedRequirements?.network,
    });
  });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  log("request_start", { url: DEFAULT_URL });
  let response: Response;
  try {
    response = await fetchWithPayment(DEFAULT_URL, { method: "GET" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("request_threw", { message: msg });
    if (BLOCK_MODE && /twzrd|abort|can_spend|blocked/i.test(msg)) {
      log("BLOCK_PASS", {
        sign_after_abort: false,
        decision_count: decisionCount,
      });
      console.log("\n=== FINAL REPORT ===");
      console.log(
        JSON.stringify(
          {
            verdict: "green_block",
            mode: "block",
            usdc_spent: 0,
            decision_count: decisionCount,
            events,
          },
          null,
          2,
        ),
      );
      return;
    }
    throw e;
  }

  log("response_status", { status: response.status });
  const bodyText = await response.text();
  let body: unknown = bodyText;
  try {
    body = JSON.parse(bodyText);
  } catch {
    /* keep text */
  }
  log("response_body_snippet", {
    snippet: bodyText.slice(0, 400),
    keys:
      body && typeof body === "object" && body !== null
        ? Object.keys(body as object).slice(0, 20)
        : [],
  });

  let paymentStatus: string | undefined;
  let paymentHeader: unknown;
  try {
    // rebuild response for processResponse if API needs headers+body
    const rebuilt = new Response(bodyText, {
      status: response.status,
      headers: response.headers,
    });
    const result = await httpClient.processResponse(rebuilt);
    paymentStatus = result.paymentStatus;
    paymentHeader = result.header;
    log("payment_result", {
      paymentStatus: result.paymentStatus,
      header: result.header
        ? {
            success: (result.header as { success?: boolean }).success,
            transaction: (result.header as { transaction?: string }).transaction,
            network: (result.header as { network?: string }).network,
          }
        : null,
    });
  } catch (e) {
    log("process_response_skip", {
      message: e instanceof Error ? e.message : String(e),
    });
    // Fallback: payment-response header
    const pr =
      response.headers.get("payment-response") ||
      response.headers.get("PAYMENT-RESPONSE") ||
      response.headers.get("x-payment-response");
    if (pr) {
      log("payment_response_header_raw", { len: pr.length, head: pr.slice(0, 120) });
    }
  }

  const decisionEvents = events.filter(
    (e) => e.event === "twzrd_onBeforePaymentCreation_decision",
  );
  const afterPay = events.filter((e) => e.event === "after_payment_creation");
  const approved = decisionEvents.some((e) => e.detail?.approved === true);
  const aborted = decisionEvents.some((e) => e.detail?.approved === false);

  const bodyObj =
    body && typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : null;
  const charged =
    bodyObj?.paid === true ||
    (typeof bodyObj?.charged_amount_usdc === "number" &&
      (bodyObj.charged_amount_usdc as number) > 0);
  const settled =
    response.status === 200 && approved && afterPay.length >= 1 && charged;

  console.log("\n=== FINAL REPORT ===");
  const report = {
    verdict: settled
      ? "green_allow"
      : aborted
        ? "green_block"
        : response.status === 200 && approved
          ? "green_allow_likely"
          : "yellow",
    mode: BLOCK_MODE ? "block" : "allow",
    url: DEFAULT_URL,
    payer: signer.address,
    response_status: response.status,
    decision_count: decisionCount,
    decisions: decisionEvents.map((e) => e.detail),
    after_payment_creation: afterPay.length,
    paymentStatus,
    paymentHeader:
      paymentHeader && typeof paymentHeader === "object"
        ? {
            success: (paymentHeader as { success?: boolean }).success,
            transaction: (paymentHeader as { transaction?: string }).transaction,
            network: (paymentHeader as { network?: string }).network,
          }
        : paymentHeader ?? null,
    usdc_spent: settled ? bodyObj?.charged_amount_usdc ?? 0.001 : 0,
    settlement_tx: bodyObj?.tx ?? null,
    binding:
      "onBeforePaymentCreation evaluated selectedRequirements before createPaymentPayload",
    events,
    body: bodyObj
      ? {
          paid: bodyObj.paid,
          tier: bodyObj.tier,
          score: bodyObj.score,
          charged_amount_usdc: bodyObj.charged_amount_usdc,
          tx: bodyObj.tx,
          network: bodyObj.network,
        }
      : bodyText.slice(0, 200),
  };
  console.log(JSON.stringify(report, null, 2));

  if (BLOCK_MODE) {
    if (response.status === 200 && approved) {
      console.error("FAIL: --block mode but payment allowed");
      process.exit(1);
    }
    return;
  }

  if (response.status !== 200) {
    console.error("FAIL: expected HTTP 200 after settle");
    process.exit(1);
  }
  if (decisionCount < 1) {
    console.error("FAIL: TWZRD hook never ran");
    process.exit(1);
  }
  if (!approved) {
    console.error("FAIL: expected approved decision for allow dogfood");
    process.exit(1);
  }
  if (afterPay.length < 1) {
    console.error("FAIL: expected after_payment_creation after approve");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("official-x402-dogfood FAILED", e);
  process.exit(1);
});
