/**
 * Last look before the signer: a `.kill` or an active `.pause` that lands while
 * the gate is still awaiting something (the intel preflight, a paid evidence
 * hop, a bound-transaction compose, a durable decision write) must stop the
 * payment. Reading the sentinel once at entry is not enough.
 *
 * One failing-first test per seat that hands a go-ahead to a signer:
 *
 *   safeFetch (spendControlSafeFetch)   the gate calls the payer itself
 *   twzrdApprovePayment                 the approval every seat is built on
 *   x402 client hook                    paid hops run after the approval
 *   evaluate_x402_resource / fetch guard  paid hops run after the approval
 *   createBuyerFetch                    a durable write runs after the approval
 *   MCP hook                            its fail-open branch
 *   safe-fetch CLI seat                 the payer is a child process
 *
 * Plus the WAL single-writer lock: a lock carrying this process's pid is not
 * stale just because this copy of the module did not write it.
 *
 * Hermetic: temp dirs, stub payers, stub fetches. Nothing signs, nothing spends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { x402Client } from "@x402/fetch";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";

import { BuyerFetchBlockedError, createBuyerFetch } from "../src/buyer-fetch.js";
import type { ResolvedTwzrdGateConfig } from "../src/config.js";
import { sharedFileDecisionLedger } from "../src/decision-ledger-file.js";
import { evaluate_x402_resource } from "../src/evaluate.js";
import { twzrdOnPaymentRequested } from "../src/mcp-hook.js";
import { twzrdApprovePayment } from "../src/policy.js";
import { createMemorySpendLedger } from "../src/policy-runtime.js";
import { resourceBindLeafHash, resourceBindMemo } from "../src/resource-bind.js";
import { safeFetch as cliSafeFetch } from "../src/safe-fetch.js";
import { spendControlSafeFetch } from "../src/spend-control.js";
import { __resetSharedFileSpendLedgers } from "../src/spend-ledger-file.js";
import { createFileSvmWal, __resetSharedFileSvmWals } from "../src/svm-wal.js";
import { withTwzrdGuard } from "../src/with-guard.js";
import { evaluateBeforePaymentCreation } from "../src/x402-client-hook.js";
import { EXACT_SVM_TRANSFER_CHECKED_FIXTURE as FIX } from "./fixtures/exact-svm-transfer-checked.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RESOURCE = "https://merchant.example/api/v1";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gate-presign-"));
}

function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function resetShared(): void {
  __resetSharedFileSvmWals();
  __resetSharedFileSpendLedgers();
}

function closeWal(wal: unknown): void {
  (wal as { close?: () => void }).close?.();
}

/** A well-formed Solana signature: 88 base58 characters. */
function sig(tag: string): string {
  return ("5" + tag.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "")).padEnd(88, "x").slice(0, 88);
}

/** A payer result that carries a signature and terminal chain evidence. */
function settled(tag: string, slot = 320_000_001) {
  return {
    txSignature: sig(tag),
    slot,
    confirmationStatus: "finalized" as const,
    response: new Response("paid", { status: 200 }),
  };
}

function dropKill(dir: string): void {
  fs.writeFileSync(path.join(dir, ".kill"), "halt\n");
}

function dropPause(dir: string, untilUnixMs: number, reason = "payment_gate_halt"): void {
  fs.writeFileSync(
    path.join(dir, ".pause"),
    JSON.stringify({ schema: "twzrd.pause_sentinel.v1", until_unix_ms: untilUnixMs, reason }) + "\n",
  );
}

function challenge(amount = "10000", payTo = SELLER, asset = USDC, resource = RESOURCE) {
  return {
    x402Version: 1,
    accepts: [{ scheme: "exact", network: SOL, payTo, maxAmountRequired: amount, asset, resource }],
  };
}

const fetchChallenge = (body: unknown = challenge()) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 402,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

/**
 * A stub intel: answers the preflight with `card` and the merchant card with a
 * clean wash signal. `duringPreflight` runs while the preflight is in flight.
 */
function intel(
  card: Record<string, unknown>,
  duringPreflight?: () => void,
  opts: { preflightStatus?: number } = {},
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/merchant_card/")) {
      return Response.json({ wash_flagged: false, wash_confidence: "full" });
    }
    duringPreflight?.();
    if (opts.preflightStatus && opts.preflightStatus !== 200) {
      return new Response("unavailable", { status: opts.preflightStatus });
    }
    return Response.json({ readiness_card: card });
  }) as unknown as typeof fetch;
}

const ALLOW_CARD = { decision: "allow", trust_score: 90, can_spend: true, seller_wallet: SELLER };
const WARN_CARD = {
  decision: "warn",
  trust_score: 50,
  can_spend: true,
  recommended_cap_usdc: 1000,
  seller_wallet: SELLER,
};

function gateConfig(dir: string, fetchImpl: typeof fetch, extra: Partial<ResolvedTwzrdGateConfig> = {}) {
  return {
    intelBase: "https://intel.example",
    fetch: fetchImpl,
    preflightMinScore: 40,
    blockDecisions: new Set(["block"]),
    failOpen: false,
    gateOnCanSpend: false,
    refuseUnevaluated: true,
    refuseUncappedWarn: true,
    intelTimeoutMs: 2000,
    refuseWashFlagged: false,
    refuseWashUnknown: false,
    washMaxUsdc: null,
    unsupportedNetworkMode: "observe" as const,
    stateDir: dir,
    ...extra,
  } as ResolvedTwzrdGateConfig;
}

/** Run `fn` with TWZRD_STATE_DIR pointed at `dir`, then restore the environment. */
async function withStateDirEnv<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TWZRD_STATE_DIR;
  process.env.TWZRD_STATE_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TWZRD_STATE_DIR;
    else process.env.TWZRD_STATE_DIR = prev;
  }
}

/* ------------------------------------------------------------------ */
/* safeFetch: the gate calls the payer itself                          */
/* ------------------------------------------------------------------ */

test("safeFetch: a .kill that lands during the async preflight never reaches the payer", async () => {
  const dir = tmpDir();
  try {
    let payerCalls = 0;
    const res = await spendControlSafeFetch(RESOURCE, {
      fetch: fetchChallenge(),
      ledger: createMemorySpendLedger(),
      maxSpend: "1.00",
      stateDir: dir,
      preflight: async () => {
        dropKill(dir);
        return { decision: "allow" as const };
      },
      pay: async () => {
        payerCalls += 1;
        return settled("late-kill");
      },
    });
    assert.equal(payerCalls, 0, "the payer must not run once .kill is on disk");
    assert.equal(res.verdict, "block");
    assert.equal(res.reason, "twzrd_kill_switch");
    assert.equal(res.signerInvocations, 0);
  } finally {
    rm(dir);
  }
});

test("safeFetch: with a WAL, a late .kill writes no intent, holds nothing, and the payment goes through once the file is gone", async () => {
  const dir = tmpDir();
  resetShared();
  try {
    const walFile = path.join(dir, "svm.wal.jsonl");
    const wal = createFileSvmWal(walFile);
    const ledger = createMemorySpendLedger();
    let payerCalls = 0;
    const call = (duringPreflight: () => void) =>
      spendControlSafeFetch(RESOURCE, {
        fetch: fetchChallenge(),
        ledger,
        svmWal: wal,
        maxSpend: "0.015",
        stateDir: dir,
        preflight: async () => {
          duringPreflight();
          return { decision: "allow" as const };
        },
        pay: async () => {
          payerCalls += 1;
          return settled("after-kill");
        },
      });

    const halted = await call(() => dropKill(dir));
    assert.equal(payerCalls, 0);
    assert.equal(halted.verdict, "block");
    assert.equal(halted.reason, "twzrd_kill_switch");
    assert.equal(halted.signerInvocations, 0);
    assert.equal(wal.hasUnresolvedIntent(), false, "a refused payment must not leave an intent behind");
    assert.equal(wal.spentMicro(), 0n, "a refused payment holds no budget");
    const rows = fs.existsSync(walFile) ? fs.readFileSync(walFile, "utf8").trim() : "";
    assert.equal(rows, "", "no WAL row is written for a payment that was never handed to the payer");

    // The operator removes the file: the same 10000 fits a 15000 cap exactly once.
    fs.rmSync(path.join(dir, ".kill"));
    const paid = await call(() => {});
    assert.equal(paid.verdict, "allow");
    assert.equal(payerCalls, 1);
    assert.equal(wal.spentMicro(), 10000n);
    closeWal(wal);
  } finally {
    resetShared();
    rm(dir);
  }
});

test("safeFetch: an active .pause that lands during the preflight stops the payer; an expired one does not", async () => {
  const dir = tmpDir();
  try {
    let payerCalls = 0;
    const call = (untilUnixMs: number) =>
      spendControlSafeFetch(RESOURCE, {
        fetch: fetchChallenge(),
        ledger: createMemorySpendLedger(),
        maxSpend: "1.00",
        stateDir: dir,
        preflight: async () => {
          dropPause(dir, untilUnixMs);
          return { decision: "allow" as const };
        },
        pay: async () => {
          payerCalls += 1;
          return settled("late-pause");
        },
      });

    const paused = await call(Date.now() + 60_000);
    assert.equal(payerCalls, 0);
    assert.equal(paused.verdict, "block");
    assert.equal(paused.reason, "twzrd_payment_paused");
    assert.equal(paused.signerInvocations, 0);

    fs.rmSync(path.join(dir, ".pause"));
    const expired = await call(Date.now() - 1_000);
    assert.equal(expired.verdict, "allow");
    assert.equal(payerCalls, 1, "an expired .pause is not a halt");
  } finally {
    rm(dir);
  }
});

test("safeFetch: a .kill that lands while the bound transaction is composed never reaches the payer", async () => {
  const dir = tmpDir();
  try {
    const kit = await import("@solana/kit");
    const token = await import("@solana-program/token");
    const owner = kit.address(FIX.expectedTokenPayer);
    const mint = kit.address(FIX.mint);
    const [ata] = await token.findAssociatedTokenPda({ owner, mint, tokenProgram: token.TOKEN_PROGRAM_ADDRESS });
    const xfer = token.getTransferCheckedInstruction({
      source: ata, mint, destination: ata, authority: owner, amount: 50000n, decimals: 6,
    });
    const lifetime = { blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n };
    const body = {
      x402Version: 1,
      accepts: [{
        scheme: "exact", network: "solana", payTo: FIX.expectedTokenPayer,
        amount: "50000", asset: FIX.mint, resource: "https://merchant.example/paid",
      }],
    };
    let payerCalls = 0;
    const run = (duringCompose: () => void) =>
      spendControlSafeFetch("https://merchant.example/paid", {
        fetch: fetchChallenge(body),
        ledger: createMemorySpendLedger(),
        stateDir: dir,
        requireOfferBinding: true,
        composeBoundTransaction: async ({ selected, memo }) => {
          assert.equal(memo, resourceBindMemo(resourceBindLeafHash(selected)));
          duringCompose();
          const wire = kit.getBase64EncodedWireTransaction(kit.compileTransaction(kit.pipe(
            kit.createTransactionMessage({ version: 0 }),
            (m) => kit.setTransactionMessageFeePayer(owner, m),
            (m) => kit.setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
            (m) => kit.appendTransactionMessageInstructions([xfer, {
              programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
              accounts: [], data: new TextEncoder().encode(String(memo)),
            }], m),
          )));
          return { transactionBase64: wire };
        },
        pay: async () => {
          payerCalls += 1;
          return { response: new Response("ok", { status: 200 }) };
        },
      });

    // Control: the same bound transaction is paid when nothing halts it.
    const control = await run(() => {});
    assert.equal(control.verdict, "allow");
    assert.equal(payerCalls, 1);

    payerCalls = 0;
    const halted = await run(() => dropKill(dir));
    assert.equal(payerCalls, 0, "a bound transaction must not be submitted once .kill is on disk");
    assert.equal(halted.verdict, "block");
    assert.equal(halted.reason, "twzrd_kill_switch");
    assert.equal(halted.signerInvocations, 0);
  } finally {
    rm(dir);
  }
});

test("safeFetch: without a payer, a late .kill withdraws the go-ahead handed to the caller", async () => {
  const dir = tmpDir();
  try {
    const res = await spendControlSafeFetch(RESOURCE, {
      fetch: fetchChallenge(),
      ledger: createMemorySpendLedger(),
      stateDir: dir,
      preflight: async () => {
        dropKill(dir);
        return { decision: "allow" as const };
      },
    });
    assert.equal(res.verdict, "block", "the caller pays on this verdict, so it must not read allow");
    assert.equal(res.reason, "twzrd_kill_switch");
    assert.equal(res.signerInvocations, 0);
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* twzrdApprovePayment: the approval every seat is built on            */
/* ------------------------------------------------------------------ */

test("twzrdApprovePayment: a .kill or an active .pause that lands during the intel preflight is refused", async () => {
  const dir = tmpDir();
  try {
    const ctx = { sellerWallet: SELLER, priceUsdc: 0.01, chain: SOL, asset: USDC };

    // Control: the same card with no sentinel is approved.
    const clean = await twzrdApprovePayment(ctx, gateConfig(dir, intel(ALLOW_CARD)));
    assert.equal(clean.approved, true);

    const killed = await twzrdApprovePayment(ctx, gateConfig(dir, intel(ALLOW_CARD, () => dropKill(dir))));
    assert.equal(killed.approved, false);
    assert.equal(killed.verdict, "block");
    assert.equal(killed.reason, "twzrd_kill_switch");
    assert.equal(killed.policyAction, "block");

    fs.rmSync(path.join(dir, ".kill"));
    const paused = await twzrdApprovePayment(
      ctx,
      gateConfig(dir, intel(ALLOW_CARD, () => dropPause(dir, Date.now() + 60_000))),
    );
    assert.equal(paused.approved, false);
    assert.match(paused.reason, /^twzrd_payment_paused/);
  } finally {
    rm(dir);
  }
});

test("twzrdApprovePayment: a fail-open outage does not skip a .kill that landed during it", async () => {
  const dir = tmpDir();
  try {
    const ctx = { sellerWallet: SELLER, priceUsdc: 0.01, chain: SOL, asset: USDC };
    const down = (during?: () => void) =>
      gateConfig(dir, intel(ALLOW_CARD, during, { preflightStatus: 503 }), { failOpen: true });

    // Control: with no sentinel the outage fails open, as configured.
    const open = await twzrdApprovePayment(ctx, down());
    assert.equal(open.approved, true);
    assert.equal(open.reason, "twzrd_fail_open");

    const killed = await twzrdApprovePayment(ctx, down(() => dropKill(dir)));
    assert.equal(killed.approved, false, "fail_open must never skip the sentinel");
    assert.equal(killed.reason, "twzrd_kill_switch");
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* x402 client hook: paid hops run after the approval                  */
/* ------------------------------------------------------------------ */

const HOOK_REQUIREMENTS = {
  payTo: SELLER,
  network: SOL,
  amount: "1000",
  asset: USDC,
  resource: "https://merchant.example/paid",
};

test("x402 client hook: a .kill that lands during the paid receipt hop aborts the payment", async () => {
  const dir = tmpDir();
  try {
    const decisions: Array<{ approved: boolean; reason: string }> = [];
    const options = (duringReceiptHop: () => void) => ({
      stateDir: dir,
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      requireReceipt: true,
      escalateOnWarn: false as const,
      fetch: intel(WARN_CARD),
      x402Fetch: (async () => {
        duringReceiptHop();
        return Response.json({ charged: true, tx: "TX_RECEIPT", twzrd_receipt: {} });
      }) as unknown as typeof fetch,
      onDecision: (d: { approved: boolean; reason: string }) => decisions.push(d),
    });

    // Control: the same hop with no sentinel proceeds (undefined = sign).
    assert.equal(await evaluateBeforePaymentCreation(HOOK_REQUIREMENTS, options(() => {})), undefined);
    assert.equal(decisions.at(-1)?.approved, true);

    const result = await evaluateBeforePaymentCreation(HOOK_REQUIREMENTS, options(() => dropKill(dir)));
    assert.ok(result && "abort" in result && result.abort, "the hook must abort once .kill is on disk");
    assert.match(String((result as { reason?: string }).reason), /twzrd_kill_switch/);
    assert.equal(decisions.at(-1)?.approved, false);
    assert.match(String(decisions.at(-1)?.reason), /twzrd_kill_switch/);
  } finally {
    rm(dir);
  }
});

test("x402 client hook: once .kill lands during one paid hop, the gate makes no further paid hop", async () => {
  const dir = tmpDir();
  try {
    const paidUrls: string[] = [];
    const options = (duringClearanceHop: () => void) => ({
      stateDir: dir,
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      // Soft clearance: a miss annotates and the hook carries on to the receipt hop.
      requirePaymentDecision: { hard: false, issuerUrl: "https://issuer.example/decision" },
      requireReceipt: true,
      escalateOnWarn: false as const,
      fetch: intel(WARN_CARD),
      x402Fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        paidUrls.push(url);
        if (url.startsWith("https://issuer.example/")) {
          duringClearanceHop();
          return new Response("no record", { status: 503 });
        }
        return Response.json({ charged: true, tx: "TX_RECEIPT", twzrd_receipt: {} });
      }) as unknown as typeof fetch,
    });

    // Control: with no sentinel both paid hops run and the hook proceeds.
    assert.equal(await evaluateBeforePaymentCreation(HOOK_REQUIREMENTS, options(() => {})), undefined);
    assert.equal(paidUrls.length, 2);

    paidUrls.length = 0;
    const result = await evaluateBeforePaymentCreation(HOOK_REQUIREMENTS, options(() => dropKill(dir)));
    assert.ok(result && "abort" in result && result.abort);
    assert.match(String((result as { reason?: string }).reason), /twzrd_kill_switch/);
    assert.deepEqual(
      paidUrls,
      ["https://issuer.example/decision"],
      "the receipt hop must not be bought after .kill landed",
    );
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* evaluate_x402_resource and the fetch guard built on it              */
/* ------------------------------------------------------------------ */

test("evaluate_x402_resource and withTwzrdGuard: a .kill that lands during the paid receipt hop withdraws the approval", async () => {
  const dir = tmpDir();
  try {
    await withStateDirEnv(dir, async () => {
      const x402Fetch = (during: () => void) =>
        (async () => {
          during();
          return Response.json({ charged: true, tx: "TX_RECEIPT", twzrd_receipt: {} });
        }) as unknown as typeof fetch;
      const opts = (during: () => void) => ({
        intelBase: "https://intel.example",
        fetch: intel(ALLOW_CARD),
        refuseWashFlagged: false,
        refuseWashUnknown: false,
        autoReceipt: true,
        x402Fetch: x402Fetch(during),
      });

      // Control: approved, with the receipt hop bought.
      const clean = await evaluate_x402_resource(RESOURCE, HOOK_REQUIREMENTS, opts(() => {}));
      assert.equal(clean.approved, true);
      assert.equal(clean.receiptFeeCaptured, true);

      const killed = await evaluate_x402_resource(RESOURCE, HOOK_REQUIREMENTS, opts(() => dropKill(dir)));
      assert.equal(killed.approved, false);
      assert.equal(killed.reason, "twzrd_kill_switch");
      assert.equal(killed.policyAction, "block");

      // The fetch guard hands the 402 back for the caller to pay: it must throw instead.
      fs.rmSync(path.join(dir, ".kill"));
      const merchant = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("https://intel.example")) return intel(ALLOW_CARD)(input);
        return new Response(JSON.stringify(challenge("1000")), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const guarded = (during: () => void) =>
        withTwzrdGuard(merchant, {
          intelBase: "https://intel.example",
          refuseWashFlagged: false,
          refuseWashUnknown: false,
          autoReceipt: true,
          escalateOnWarn: false,
          x402Fetch: x402Fetch(during),
        });
      assert.equal((await guarded(() => {})(RESOURCE)).status, 402);
      await assert.rejects(guarded(() => dropKill(dir))(RESOURCE), /payment blocked: twzrd_kill_switch/);
    });
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* createBuyerFetch: a durable write runs after the approval           */
/* ------------------------------------------------------------------ */

test("buyer fetch: a .kill that lands during the durable decision write stops the signature", async () => {
  const dir = tmpDir();
  resetShared();
  try {
    const NETWORK = "eip155:8453" as const;
    const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const BASE_SELLER = "0x1111111111111111111111111111111111111111";
    const URL_PAID = "https://merchant.example/paid";
    const state = { signs: 0, paid: 0 };

    const build = (sub: string) => {
      const client = new x402Client();
      client.setSpendControls(false);
      const scheme: SchemeNetworkClient = {
        scheme: "exact",
        async createPaymentPayload(version) {
          state.signs += 1;
          return { x402Version: version, payload: { fixture: true } };
        },
      };
      client.register(NETWORK, scheme);
      const payment: PaymentRequired = {
        x402Version: 2,
        resource: { url: URL_PAID },
        accepts: [{ scheme: "exact", network: NETWORK, asset: BASE_USDC, amount: "1000",
          payTo: BASE_SELLER, maxTimeoutSeconds: 60, extra: {} }],
      };
      const transport: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url.includes("/v1/intel/preflight")) {
          return Response.json({ readiness_card: {
            decision: "allow", trust_score: 90, seller_wallet: BASE_SELLER, recommended_cap_usdc: 1,
          } });
        }
        if (request.url.includes("/v1/intel/merchant_card/")) {
          return Response.json({ wash_flagged: false, wash_confidence: "full" });
        }
        if (request.headers.has("payment-signature")) {
          state.paid += 1;
          return Response.json({ ok: true });
        }
        return new Response(null, { status: 402, headers: {
          "payment-required": Buffer.from(JSON.stringify(payment)).toString("base64"),
        } });
      };
      const decisionFile = path.join(dir, sub, "decisions.jsonl");
      fs.mkdirSync(path.dirname(decisionFile), { recursive: true });
      return {
        decisionFile,
        fetch: createBuyerFetch({
          client, maxPricePerCall: "0.05", allowedRecipients: [BASE_SELLER],
          decisionFile, spendLedgerFile: path.join(dir, sub, "spend.jsonl"),
          intelTimeoutMs: 2000, fetch: transport,
        }),
      };
    };

    await withStateDirEnv(dir, async () => {
      // Control: nothing halts it, so it signs and pays once.
      const clean = build("clean");
      assert.equal((await clean.fetch(URL_PAID)).status, 200);
      assert.equal(state.signs, 1);
      assert.equal(state.paid, 1);

      // The allow row is flushed to disk before signing; .kill lands during that write.
      state.signs = 0;
      state.paid = 0;
      const late = build("late");
      const ledger = sharedFileDecisionLedger(late.decisionFile);
      const flush = ledger.flush.bind(ledger);
      let dropped = false;
      ledger.flush = async () => {
        await flush();
        if (!dropped) {
          dropped = true;
          dropKill(dir);
        }
      };
      await assert.rejects(late.fetch(URL_PAID), (error: unknown) => {
        assert.ok(error instanceof BuyerFetchBlockedError);
        assert.equal(error.reason, "twzrd_kill_switch");
        return true;
      });
      assert.equal(state.signs, 0, "nothing is signed once .kill is on disk");
      assert.equal(state.paid, 0);
    });
  } finally {
    resetShared();
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* MCP hook: the fail-open branch                                      */
/* ------------------------------------------------------------------ */

test("MCP hook: the fail-open branch does not approve a payment while .kill is on disk", async () => {
  const dir = tmpDir();
  try {
    const offer = { scheme: "exact", network: SOL, payTo: SELLER, maxAmountRequired: "1000", asset: USDC };
    // A request that makes the hook throw after its offers were read.
    const request = () => ({
      accepts: [offer],
      context: {
        toolName: "paid_tool",
        get resource(): string {
          throw new Error("context getter failed");
        },
      },
    });
    const cfg = gateConfig(dir, intel(ALLOW_CARD), { failOpen: true });

    // Control: fail-open is what the host asked for when nothing halts payments.
    assert.equal(await twzrdOnPaymentRequested(request(), cfg), true);

    dropKill(dir);
    assert.equal(
      await twzrdOnPaymentRequested(request(), cfg),
      false,
      "fail_open must never skip the sentinel",
    );
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* safe-fetch CLI seat: the payer is a child process                   */
/* ------------------------------------------------------------------ */

test("safe-fetch seat: a .kill that lands during the preflight never invokes the payer", async () => {
  const dir = tmpDir();
  try {
    await withStateDirEnv(dir, async () => {
      let payerCalls = 0;
      const run = (duringPreflight: () => void) =>
        cliSafeFetch({
          url: "https://merchant.example/paid",
          refuseWashFlagged: false,
          refuseWashUnknown: false,
          fetch: (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("/preflight")) return intel(ALLOW_CARD, duringPreflight)(input);
            return new Response(
              JSON.stringify({ accepts: [{ network: SOL, payTo: SELLER, amount: "1000" }] }),
              { status: 402, headers: { "content-type": "application/json" } },
            );
          }) as unknown as typeof fetch,
          runPayer: async () => {
            payerCalls += 1;
            return { exitCode: 0, stdout: "{}", stderr: "" };
          },
        });

      // Control: the payer runs when nothing halts it.
      await run(() => {});
      assert.equal(payerCalls, 1);

      payerCalls = 0;
      const halted = await run(() => dropKill(dir));
      assert.equal(payerCalls, 0, "the payer must not be spawned once .kill is on disk");
      assert.equal(halted.ok, false);
      assert.equal(halted.phase, "blocked");
      assert.equal(halted.error, "twzrd_kill_switch");
    });
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* WAL single writer: a same-pid lock is not stale by default          */
/* ------------------------------------------------------------------ */

const INTENT = {
  paymentDecisionId: "decision-1",
  payTo: SELLER,
  amountMicro: "10000",
  network: SOL,
};

test("WAL lock: a second copy of the module in the same process is refused while the first holds the file", async () => {
  const dir = tmpDir();
  resetShared();
  try {
    const walFile = path.join(dir, "svm.wal.jsonl");
    // A distinct module instance, as a second installed copy or a second bundle would be.
    const specifier = "../src/svm-wal.js" + "?copy=presign-sentinel";
    const copy = (await import(specifier)) as typeof import("../src/svm-wal.js");
    assert.notEqual(copy.createFileSvmWal, createFileSvmWal, "the import must be a separate module instance");

    const first = createFileSvmWal(walFile);
    const intent = first.appendIntent({ ...INTENT, challengeHash: "a".repeat(64) });

    assert.throws(() => copy.createFileSvmWal(walFile), /wal_single_writer_lock/);

    // The first owner was not displaced: it still appends, and the chain is intact.
    first.appendReceipt({
      intentId: intent.intent_id,
      status: "confirmed",
      txSignature: sig("copy"),
      slot: 320_000_001,
      confirmationStatus: "finalized",
    });
    closeWal(first);

    // Once it is released, the other copy opens it and replays both rows.
    const reopened = copy.createFileSvmWal(walFile);
    assert.equal(reopened.lookupChallenge("a".repeat(64)).state, "confirmed");
    assert.equal(reopened.hasUnresolvedIntent(), false);
    assert.equal(reopened.spentMicro(), 10000n);
    closeWal(reopened);
  } finally {
    resetShared();
    rm(dir);
  }
});

test("WAL lock: a same-pid lock from an earlier process is taken over; one held by this live process is refused", { skip: !fs.existsSync("/proc/self/stat") }, () => {
  const dir = tmpDir();
  resetShared();
  try {
    const walFile = path.join(dir, "svm.wal.jsonl");
    const lockFile = `${walFile}.lock`;
    const stat = fs.readFileSync("/proc/self/stat", "utf8");
    const ownStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    assert.match(ownStart, /^\d+$/);

    // A container restart: the new process has the old pid but a different start time.
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid, instance_id: "earlier-process", at_unix_ms: 1, proc_start: "1",
    }) + "\n");
    const taken = createFileSvmWal(walFile);
    taken.appendIntent({ ...INTENT, challengeHash: "c".repeat(64) });
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.proc_start, ownStart, "the lock records which process start it belongs to");
    closeWal(taken);

    // Another thread or realm of this same live process: same pid, same start, unknown owner.
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid, instance_id: "another-realm", at_unix_ms: Date.now(), proc_start: ownStart,
    }) + "\n");
    assert.throws(() => createFileSvmWal(walFile), /wal_single_writer_lock/);
    fs.rmSync(lockFile);

    // A recycled pid: a live process, but not the one that wrote the lock.
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.ppid, instance_id: "recycled-pid", at_unix_ms: 1, proc_start: "1",
    }) + "\n");
    const recycled = createFileSvmWal(walFile);
    assert.equal(recycled.spentMicro(), 10000n);
    closeWal(recycled);
  } finally {
    resetShared();
    rm(dir);
  }
});

const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";

test("WAL lock: a lock written under an earlier boot is taken over even when pid and start time match", { skip: !fs.existsSync("/proc/self/stat") || !fs.existsSync(BOOT_ID_FILE) }, () => {
  const dir = tmpDir();
  resetShared();
  try {
    const walFile = path.join(dir, "svm.wal.jsonl");
    const lockFile = `${walFile}.lock`;
    const stat = fs.readFileSync("/proc/self/stat", "utf8");
    const ownStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const ownBoot = fs.readFileSync(BOOT_ID_FILE, "utf8").trim();
    assert.match(ownBoot, /^[0-9a-f-]{36}$/);

    // After a host reboot a service can come back with the same pid at the same
    // tick since boot. Start times only compare within one boot.
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid, instance_id: "before-reboot", at_unix_ms: 1, proc_start: ownStart,
      boot_id: "00000000-0000-4000-8000-000000000000",
    }) + "\n");
    const taken = createFileSvmWal(walFile);
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    assert.equal(lock.boot_id, ownBoot, "the lock records which boot it was written under");
    assert.equal(lock.proc_start, ownStart);
    closeWal(taken);

    // Same boot, same pid, same start: this live process holds it somewhere else.
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid, instance_id: "another-realm", at_unix_ms: Date.now(), proc_start: ownStart,
      boot_id: ownBoot,
    }) + "\n");
    assert.throws(() => createFileSvmWal(walFile), /wal_single_writer_lock/);
    fs.rmSync(lockFile);

    // An earlier boot wins over a pid that happens to be alive now.
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.ppid, instance_id: "before-reboot-other-pid", at_unix_ms: 1,
      boot_id: "00000000-0000-4000-8000-000000000000",
    }) + "\n");
    closeWal(createFileSvmWal(walFile));
  } finally {
    resetShared();
    rm(dir);
  }
});
