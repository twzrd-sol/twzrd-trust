/**
 * Lock-review release blockers: one failing-first test per finding of the
 * read-only review of main 71f0ac3f, kept as the regression suite for them.
 *
 * B1  MPP honours .kill / .pause before any credential is created.
 * B2  A confirmed WAL intent counts against the cap exactly once, also after recovery.
 * B3  No `confirmed` receipt without a tx signature and terminal evidence.
 * B4  One WAL writer per file.
 * B5  A cap trip writes a .pause that expires with the budget window; tripPauseOnBlockMs
 *     stays opt-in and fires on fatal refusals only.
 * B6  A pre-sign payment_intent row carries no tx_signature.
 * B7  parseBindingPolicy defaults to the caller's own section.
 * B8  No enclave / custody wording in the WAL module.
 *
 * Hermetic: temp dirs, stub payers, stub credential creators. Nothing signs, nothing spends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as bindingPlane from "../src/binding-plane.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import {
  createTwzrdMppOnChallenge,
  evaluateTwzrdMppChallenge,
  TwzrdMppBlockError,
  type MppChallenge,
} from "../src/mpp-hook.js";
import { twzrdApprovePayment } from "../src/policy.js";
import { createMemorySpendLedger } from "../src/policy-runtime.js";
import { spendControlSafeFetch } from "../src/spend-control.js";
import { __resetSharedFileSpendLedgers } from "../src/spend-ledger-file.js";
import { createFileSvmWal, __resetSharedFileSvmWals } from "../src/svm-wal.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const OTHER_SELLER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MPP_MERCHANT = "MerchantWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** A well-formed Solana signature: 88 base58 characters. */
function sig(tag: string): string {
  return ("5" + tag.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "")).padEnd(88, "x").slice(0, 88);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gate-lock-review-"));
}

function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Release a WAL the test is done with (the single-writer lock is per owner). */
function closeWal(wal: unknown): void {
  (wal as { close?: () => void }).close?.();
}

function resetShared(): void {
  __resetSharedFileSvmWals();
  __resetSharedFileSpendLedgers();
}

function challengeResponse(
  amount = "10000",
  resource = "https://merchant.example/api/v1",
  payTo = SELLER,
) {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [
        { scheme: "exact", network: SOL, payTo, maxAmountRequired: amount, asset: USDC, resource },
      ],
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  );
}

const fetchChallenge = (amount: string, resource?: string, payTo?: string) =>
  (async () => challengeResponse(amount, resource, payTo)) as unknown as typeof fetch;

/** A payer result that carries a signature and terminal chain evidence. */
function settled(tag: string, slot = 320_000_001) {
  return {
    txSignature: sig(tag),
    slot,
    confirmationStatus: "finalized" as const,
    response: new Response("paid", { status: 200 }),
  };
}

function mppCharge(id = "chal_lock_1"): MppChallenge {
  return {
    id,
    realm: "api.example.com",
    method: "solana",
    intent: "charge",
    request: { amount: "50000", currency: USDC, decimals: 6, recipient: MPP_MERCHANT },
  };
}

function credentialStub() {
  const state = { created: 0 };
  return {
    state,
    helpers: {
      createCredential: async () => {
        state.created += 1;
        return "Payment credential=stub";
      },
    },
  };
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

function mppGuard(dir: string, extra: Record<string, unknown> = {}) {
  return createTwzrdMppOnChallenge({
    signer: createLocalDecisionSigner({ keyId: "lock-review" }),
    policy: { maxAmountUsd: "1.00" },
    intelligence: () => ({ known: true, washFlagged: false, decision: "allow" as const }),
    decisionFile: path.join(dir, "decisions.jsonl"),
    ...extra,
  });
}

function writePause(dir: string, untilUnixMs: number, reason = "payment_gate_halt"): void {
  fs.writeFileSync(
    path.join(dir, ".pause"),
    JSON.stringify({ schema: "twzrd.pause_sentinel.v1", until_unix_ms: untilUnixMs, reason }) + "\n",
  );
}

/* ------------------------------------------------------------------ */
/* B1 — MPP sentinel veto                                              */
/* ------------------------------------------------------------------ */

test("B1: MPP onChallenge with .kill in TWZRD_STATE_DIR never invokes the credential creator", async () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ".kill"), "halt\n");
    const { state, helpers } = credentialStub();
    await withStateDirEnv(dir, async () => {
      await assert.rejects(
        () => mppGuard(dir)(mppCharge(), helpers),
        (e: unknown) =>
          e instanceof TwzrdMppBlockError && (e.reasonCodes ?? []).includes("twzrd_kill_switch"),
      );
    });
    assert.equal(state.created, 0, "credential creator must not run while .kill is present");
  } finally {
    rm(dir);
  }
});

test("B1: MPP onChallenge with a valid unexpired .pause never invokes the credential creator", async () => {
  const dir = tmpDir();
  try {
    writePause(dir, Date.now() + 60_000, "over_cumulative_spend");
    const { state, helpers } = credentialStub();
    await withStateDirEnv(dir, async () => {
      await assert.rejects(
        () => mppGuard(dir)(mppCharge(), helpers),
        (e: unknown) =>
          e instanceof TwzrdMppBlockError && (e.reasonCodes ?? []).includes("twzrd_payment_paused"),
      );
    });
    assert.equal(state.created, 0, "credential creator must not run while .pause is active");

    // A corrupt .pause fails closed the same way.
    fs.writeFileSync(path.join(dir, ".pause"), "{not json");
    await withStateDirEnv(dir, async () => {
      await assert.rejects(
        () => mppGuard(dir)(mppCharge("chal_lock_corrupt"), helpers),
        (e: unknown) =>
          e instanceof TwzrdMppBlockError && (e.reasonCodes ?? []).includes("twzrd_pause_corrupt"),
      );
    });
    assert.equal(state.created, 0);
  } finally {
    rm(dir);
  }
});

test("B1: MPP onChallenge with an expired .pause proceeds to the credential creator", async () => {
  const dir = tmpDir();
  try {
    writePause(dir, Date.now() - 1_000);
    const { state, helpers } = credentialStub();
    const credential = await withStateDirEnv(dir, () => mppGuard(dir)(mppCharge(), helpers));
    assert.equal(credential, "Payment credential=stub");
    assert.equal(state.created, 1, "an expired .pause is not a veto");
  } finally {
    rm(dir);
  }
});

test("B1: neither a fail-open outage, an unchecked seller, nor allowUnevaluated skips the MPP sentinel", async () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, ".kill"), "halt\n");
    const { state, helpers } = credentialStub();
    await withStateDirEnv(dir, async () => {
      // No intelligence provider at all: unchecked sellers proceed on warn by default.
      const unchecked = createTwzrdMppOnChallenge({
        signer: createLocalDecisionSigner({ keyId: "lock-review" }),
        decisionFile: path.join(dir, "decisions.jsonl"),
      });
      await assert.rejects(() => unchecked(mppCharge("chal_unchecked"), helpers), TwzrdMppBlockError);

      // A provider that failed open on an outage reports "warn": still vetoed.
      const failOpen = mppGuard(dir, { intelligence: () => ({ decision: "warn" as const }) });
      await assert.rejects(() => failOpen(mppCharge("chal_fail_open"), helpers), TwzrdMppBlockError);

      // An unevaluated method with the ungated opt-out must not fall through to mppx.
      const optOut = mppGuard(dir, { allowUnevaluated: true });
      await assert.rejects(
        () => optOut({ ...mppCharge("chal_stripe"), method: "stripe" }, helpers),
        TwzrdMppBlockError,
      );

      // Rails that own credential creation get the same veto from the evaluate-only entry.
      await assert.rejects(
        () =>
          evaluateTwzrdMppChallenge(mppCharge("chal_rail"), {
            signer: createLocalDecisionSigner({ keyId: "lock-review" }),
            decisionFile: path.join(dir, "decisions.jsonl"),
          }),
        (e: unknown) =>
          e instanceof TwzrdMppBlockError && (e.reasonCodes ?? []).includes("twzrd_kill_switch"),
      );
    });
    assert.equal(state.created, 0);
  } finally {
    rm(dir);
  }
});

test("B1: a .kill that lands during evaluation still stops the credential", async () => {
  const dir = tmpDir();
  try {
    const { state, helpers } = credentialStub();
    await withStateDirEnv(dir, async () => {
      const guard = mppGuard(dir, {
        // The sentinel appears after the first check, while the decision is being made.
        intelligence: () => {
          fs.writeFileSync(path.join(dir, ".kill"), "halt\n");
          return { known: true, washFlagged: false, decision: "allow" as const };
        },
      });
      await assert.rejects(
        () => guard(mppCharge("chal_race"), helpers),
        (e: unknown) =>
          e instanceof TwzrdMppBlockError && (e.reasonCodes ?? []).includes("twzrd_kill_switch"),
      );
    });
    assert.equal(state.created, 0);
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* B2 — recovered and confirmed spend counts exactly once              */
/* ------------------------------------------------------------------ */

test("B2: recovered confirmed WAL spend counts against maxSpend (15000 recovered + 10000 under a 20000 cap refuses)", async () => {
  const dir = tmpDir();
  try {
    const wal = createFileSvmWal(path.join(dir, "svm-wal.jsonl"));
    wal.appendIntent({
      challengeHash: HASH_A,
      paymentDecisionId: "dec_recovered",
      payTo: SELLER,
      amountMicro: "15000",
      network: SOL,
    });
    const rec = await wal.recoverUnresolvedIntents(async () => ({
      status: "confirmed",
      txSignature: sig("recovered"),
      slot: 320_000_001,
    }));
    assert.equal(rec.resolved, 1);
    assert.equal(wal.hasUnresolvedIntent(), false);

    let signerCalls = 0;
    const res = await spendControlSafeFetch("https://merchant.example/api/v2", {
      svmWal: wal,
      ledger: createMemorySpendLedger(), // empty spend ledger, as in the review repro
      maxSpend: "0.02",
      decisionId: "dec_after_recovery",
      fetch: fetchChallenge("10000", "https://merchant.example/api/v2"),
      pay: async () => {
        signerCalls += 1;
        return settled("mustnotsign");
      },
    });
    assert.equal(res.verdict, "block", "15000 recovered + 10000 requested exceeds the 20000 cap");
    assert.equal(res.reason, "over_cumulative_spend");
    assert.equal(res.signerInvocations, 0);
    assert.equal(signerCalls, 0);
    closeWal(wal);
  } finally {
    rm(dir);
  }
});

test("B2: a confirmed payment counts exactly once, in-process and after a restart with a file ledger and WAL", async () => {
  const dir = tmpDir();
  try {
    resetShared();
    const opts = {
      svmWalFile: path.join(dir, "svm-wal.jsonl"),
      ledgerFile: path.join(dir, "payment-spend-ledger.jsonl"),
      maxSpend: "0.02",
    };
    let signerCalls = 0;
    const pay = (tag: string) => async () => {
      signerCalls += 1;
      return settled(tag);
    };

    const first = await spendControlSafeFetch("https://merchant.example/api/one", {
      ...opts,
      decisionId: "dec_once_1",
      fetch: fetchChallenge("10000", "https://merchant.example/api/one"),
      pay: pay("first"),
    });
    assert.equal(first.verdict, "allow");
    assert.equal(first.signerInvocations, 1);

    // Restart: drop every in-memory instance and replay both files from disk.
    resetShared();

    const second = await spendControlSafeFetch("https://merchant.example/api/two", {
      ...opts,
      decisionId: "dec_once_2",
      fetch: fetchChallenge("10000", "https://merchant.example/api/two"),
      pay: pay("second"),
    });
    assert.equal(second.verdict, "allow", "10000 + 10000 is exactly the 20000 cap: counted once, it fits");
    assert.equal(second.signerInvocations, 1);

    resetShared();

    const third = await spendControlSafeFetch("https://merchant.example/api/three", {
      ...opts,
      decisionId: "dec_once_3",
      fetch: fetchChallenge("1", "https://merchant.example/api/three"),
      pay: pay("third"),
    });
    assert.equal(third.verdict, "block", "20000 is spent: one more micro must refuse (never neither)");
    assert.equal(third.reason, "over_cumulative_spend");
    assert.equal(third.signerInvocations, 0);
    assert.equal(signerCalls, 2);
  } finally {
    resetShared();
    rm(dir);
  }
});

test("B2: an ambiguous payer throw is held once, and a recovered non-landing releases all of it", async () => {
  const dir = tmpDir();
  try {
    const wal = createFileSvmWal(path.join(dir, "svm-wal.jsonl"));
    const ledger = createMemorySpendLedger();
    await assert.rejects(
      () =>
        spendControlSafeFetch("https://merchant.example/api/v1", {
          svmWal: wal,
          ledger,
          maxSpend: "0.02",
          decisionId: "dec_throw",
          fetch: fetchChallenge("10000"),
          pay: async () => {
            throw new Error("RPC connection lost after broadcast");
          },
        }),
      /RPC connection lost/,
    );
    assert.equal(wal.heldMicro(), 10000n, "the in-flight amount is held by the WAL");

    // Recovery proves the transaction never landed: nothing was spent.
    await wal.recoverUnresolvedIntents(async () => ({ status: "expired_blockhash" }));
    assert.equal(wal.heldMicro(), 0n);

    // The whole cap is available again. A second copy of the 10000 in the spend
    // ledger would refuse this.
    const res = await spendControlSafeFetch("https://merchant.example/api/full", {
      svmWal: wal,
      ledger,
      maxSpend: "0.02",
      decisionId: "dec_full_cap",
      fetch: fetchChallenge("20000", "https://merchant.example/api/full"),
      pay: async () => settled("fullcap"),
    });
    assert.equal(res.verdict, "allow");
    assert.equal(res.signerInvocations, 1);
    closeWal(wal);
  } finally {
    rm(dir);
  }
});

test("B2: an in-flight payment is counted once while the payer runs and once after it settles", async () => {
  const dir = tmpDir();
  try {
    const wal = createFileSvmWal(path.join(dir, "svm-wal.jsonl"));
    const ledger = createMemorySpendLedger();
    const base = { svmWal: wal, ledger, maxSpend: "0.02" };
    let finishFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => (finishFirst = resolve));
    let payerEntered!: () => void;
    const firstPayerRunning = new Promise<void>((resolve) => (payerEntered = resolve));

    const first = spendControlSafeFetch("https://merchant.example/api/one", {
      ...base,
      decisionId: "dec_flight_1",
      fetch: fetchChallenge("10000", "https://merchant.example/api/one"),
      pay: async () => {
        payerEntered();
        await firstMayFinish;
        return settled("inflight");
      },
    });
    await firstPayerRunning;
    assert.equal(wal.heldMicro(), 10000n, "the intent row holds the amount while the payer runs");

    // A second payment while the first is unresolved is refused before any signature.
    let secondSigned = 0;
    const second = await spendControlSafeFetch("https://merchant.example/api/two", {
      ...base,
      decisionId: "dec_flight_2",
      fetch: fetchChallenge("10000", "https://merchant.example/api/two"),
      pay: async () => {
        secondSigned += 1;
        return settled("mustwait");
      },
    });
    assert.equal(second.verdict, "block");
    assert.equal(second.reason, "wal_unresolved_intent");
    assert.equal(secondSigned, 0);

    finishFirst();
    assert.equal((await first).verdict, "allow");
    assert.equal(wal.heldMicro(), 0n);
    assert.equal(wal.confirmedMicro(), 10000n);
    assert.equal(ledger.spentMicro("agent:default", 365 * 24 * 3600 * 1000, Date.now()), 0n,
      "a WAL-tracked payment is not also written to the spend ledger");

    // Counted once: exactly 10000 of the 20000 cap is left.
    const exact = await spendControlSafeFetch("https://merchant.example/api/three", {
      ...base,
      decisionId: "dec_flight_3",
      fetch: fetchChallenge("10000", "https://merchant.example/api/three"),
      pay: async () => settled("exactfit"),
    });
    assert.equal(exact.verdict, "allow");
    const over = await spendControlSafeFetch("https://merchant.example/api/four", {
      ...base,
      decisionId: "dec_flight_4",
      fetch: fetchChallenge("1", "https://merchant.example/api/four"),
      pay: async () => settled("overcap"),
    });
    assert.equal(over.reason, "over_cumulative_spend");
    assert.equal(over.signerInvocations, 0);
    closeWal(wal);
  } finally {
    rm(dir);
  }
});

test("B2: WAL-tracked spend counts against the agent, merchant, and mandate it was paid under, and no other", async () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "svm-wal.jsonl");
    let wal = createFileSvmWal(walFile);
    const paid = await spendControlSafeFetch("https://merchant.example/api/one", {
      svmWal: wal,
      ledger: createMemorySpendLedger(),
      maxSpend: "0.02",
      agentId: "agent-a",
      mandateId: "mandate-a",
      decisionId: "dec_scope_1",
      fetch: fetchChallenge("15000", "https://merchant.example/api/one"),
      pay: async () => settled("scoped"),
    });
    assert.equal(paid.verdict, "allow");

    // Survives a restart: the scopes are on the intent row, not in memory.
    closeWal(wal);
    wal = createFileSvmWal(walFile);
    const ask = (agentId: string, mandateId: string, payTo: string, tag: string) =>
      spendControlSafeFetch(`https://merchant.example/api/${tag}`, {
        svmWal: wal,
        ledger: createMemorySpendLedger(),
        maxSpend: "0.02",
        agentId,
        mandateId,
        decisionId: `dec_scope_${tag}`,
        fetch: fetchChallenge("10000", `https://merchant.example/api/${tag}`, payTo),
        pay: async () => settled(tag),
      });

    for (const [agentId, mandateId, payTo, tag] of [
      ["agent-a", "mandate-b", OTHER_SELLER, "sameagent"],
      ["agent-b", "mandate-a", OTHER_SELLER, "samemandate"],
      ["agent-b", "mandate-b", SELLER, "samemerchant"],
    ] as const) {
      const res = await ask(agentId, mandateId, payTo, tag);
      assert.equal(res.reason, "over_cumulative_spend", `${tag}: 15000 + 10000 exceeds that key's 20000`);
      assert.equal(res.signerInvocations, 0, tag);
    }
    // Another agent, mandate, and merchant has spent nothing.
    const other = await ask("agent-b", "mandate-b", OTHER_SELLER, "unrelated");
    assert.equal(other.verdict, "allow");
    assert.equal(other.signerInvocations, 1);
    closeWal(wal);
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* B3 — no confirmed receipt without chain evidence                    */
/* ------------------------------------------------------------------ */

test("B3: an empty payer return leaves the intent unresolved, holds the amount, and freezes new payments", async () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "svm-wal.jsonl");
    const wal = createFileSvmWal(walFile);
    let signerCalls = 0;
    const first = await spendControlSafeFetch("https://merchant.example/api/v1", {
      svmWal: wal,
      maxSpend: "0.05",
      ledger: createMemorySpendLedger(),
      decisionId: "dec_empty",
      fetch: fetchChallenge("10000"),
      pay: async () => {
        signerCalls += 1;
        return {};
      },
    });
    assert.equal(signerCalls, 1);
    assert.notEqual(first.verdict, "allow", "an unproven payment is not reported as settled");
    assert.equal(first.reason, "wal_unconfirmed_payment");
    assert.equal(first.signerInvocations, 1);

    assert.equal(wal.hasUnresolvedIntent(), true, "no receipt: the intent stays unresolved");
    assert.equal(wal.heldMicro(), 10000n, "amount_micro stays held");
    assert.equal(wal.confirmedMicro(), 0n);
    const rows = fs.readFileSync(walFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["payment_intent"],
      "no payment_receipt row may be written for an unproven payment",
    );

    const frozen = await spendControlSafeFetch("https://merchant.example/api/v2", {
      svmWal: wal,
      maxSpend: "0.05",
      ledger: createMemorySpendLedger(),
      decisionId: "dec_after_empty",
      fetch: fetchChallenge("5000", "https://merchant.example/api/v2"),
      pay: async () => {
        signerCalls += 1;
        return settled("frozen");
      },
    });
    assert.equal(frozen.verdict, "block");
    assert.equal(frozen.reason, "wal_unresolved_intent");
    assert.equal(frozen.signerInvocations, 0);
    assert.equal(signerCalls, 1, "new payments are frozen until recovery resolves the intent");
    closeWal(wal);
  } finally {
    rm(dir);
  }
});

test("B3: a signature without terminal chain evidence stays unresolved", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["signature only", { txSignature: sig("sigonly") }],
    ["slot only", { slot: 320_000_001, confirmationStatus: "finalized" }],
    ["processed is not terminal", { txSignature: sig("processed"), slot: 320_000_001, confirmationStatus: "processed" }],
    ["malformed signature", { txSignature: "ok", slot: 320_000_001, confirmationStatus: "finalized" }],
    ["non-positive slot", { txSignature: sig("slotzero"), slot: 0, confirmationStatus: "finalized" }],
  ];
  for (const [label, paid] of cases) {
    const dir = tmpDir();
    try {
      const wal = createFileSvmWal(path.join(dir, "svm-wal.jsonl"));
      const res = await spendControlSafeFetch("https://merchant.example/api/v1", {
        svmWal: wal,
        ledger: createMemorySpendLedger(),
        decisionId: "dec_no_evidence",
        fetch: fetchChallenge("10000"),
        pay: async () => paid as never,
      });
      assert.equal(res.reason, "wal_unconfirmed_payment", label);
      assert.equal(wal.hasUnresolvedIntent(), true, label);
      assert.equal(wal.heldMicro(), 10000n, label);
      assert.equal(wal.lookupChallenge(wal.unresolvedIntents()[0]!.challenge_hash).state, "pending", label);
      closeWal(wal);
    } finally {
      rm(dir);
    }
  }
});

test("B3: a valid signature with terminal status is confirmed exactly once", async () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "svm-wal.jsonl");
    const wal = createFileSvmWal(walFile);
    let signerCalls = 0;
    const call = () =>
      spendControlSafeFetch("https://merchant.example/api/v1", {
        svmWal: wal,
        ledger: createMemorySpendLedger(),
        maxSpend: "0.05",
        decisionId: "dec_confirmed",
        fetch: fetchChallenge("10000"),
        pay: async () => {
          signerCalls += 1;
          return settled("confirmed", 320_000_777);
        },
      });
    const first = await call();
    assert.equal(first.verdict, "allow");
    assert.equal(first.signerInvocations, 1);
    assert.equal(first.txSignature, sig("confirmed"));
    assert.equal(wal.hasUnresolvedIntent(), false);
    assert.equal(wal.confirmedMicro(), 10000n);

    // The same challenge replays the recorded receipt: no second signature, no second receipt.
    const replay = await call();
    assert.equal(replay.verdict, "allow");
    assert.equal(replay.signerInvocations, 0);
    assert.equal(replay.txSignature, sig("confirmed"));
    assert.equal(signerCalls, 1);

    const rows = fs.readFileSync(walFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const receipts = rows.filter((r) => r.kind === "payment_receipt");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, "confirmed");
    assert.equal(receipts[0].tx_signature, sig("confirmed"));
    assert.equal(receipts[0].slot, 320_000_777);
    assert.equal(wal.confirmedMicro(), 10000n, "counted once");
    closeWal(wal);
  } finally {
    rm(dir);
  }
});

test("B3: a facilitator settlement confirms only when the payer marks it verified and names the facilitator", async () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["verified", { verified: true, facilitator: "facilitator.example" }, true],
    ["not verified", { verified: false, facilitator: "facilitator.example" }, false],
    ["truthy but not true", { verified: "yes", facilitator: "facilitator.example" }, false],
    ["unnamed", { verified: true, facilitator: " " }, false],
  ];
  for (const [label, facilitatorSettlement, confirms] of cases) {
    const dir = tmpDir();
    try {
      const walFile = path.join(dir, "svm-wal.jsonl");
      const wal = createFileSvmWal(walFile);
      const res = await spendControlSafeFetch("https://merchant.example/api/v1", {
        svmWal: wal,
        ledger: createMemorySpendLedger(),
        decisionId: "dec_facilitator",
        fetch: fetchChallenge("10000"),
        // No slot and no commitment: the facilitator's settlement is the only evidence.
        pay: async () => ({ txSignature: sig("facilitated"), facilitatorSettlement }) as never,
      });
      const rows = fs.readFileSync(walFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const receipts = rows.filter((r) => r.kind === "payment_receipt");
      if (confirms) {
        assert.equal(res.verdict, "allow", label);
        assert.equal(wal.hasUnresolvedIntent(), false, label);
        assert.equal(receipts.length, 1, label);
        assert.equal(receipts[0].status, "confirmed", label);
        assert.equal(receipts[0].facilitator, "facilitator.example", label);
        assert.equal(receipts[0].slot, null, label);
        // The receipt replays from disk as settled.
        closeWal(wal);
        const reopened = createFileSvmWal(walFile);
        assert.equal(reopened.confirmedMicro(), 10000n, label);
        closeWal(reopened);
      } else {
        assert.equal(res.reason, "wal_unconfirmed_payment", label);
        assert.equal(wal.hasUnresolvedIntent(), true, label);
        assert.equal(receipts.length, 0, label);
        closeWal(wal);
      }
    } finally {
      rm(dir);
    }
  }
});

test("B3: recovery and replay cannot produce a confirmed receipt without a signature and slot", async () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "svm-wal.jsonl");
    const wal = createFileSvmWal(walFile);
    const intent = wal.appendIntent({
      challengeHash: HASH_A,
      paymentDecisionId: "dec_recover_bad",
      payTo: SELLER,
      amountMicro: "15000",
      network: SOL,
    });
    await assert.rejects(() => wal.recoverUnresolvedIntents(async () => ({ status: "confirmed" })));
    assert.throws(() => wal.appendReceipt({ intentId: intent.intent_id, status: "confirmed" }));
    assert.throws(() =>
      wal.appendReceipt({ intentId: intent.intent_id, status: "confirmed", txSignature: sig("noslot") }),
    );
    assert.equal(wal.hasUnresolvedIntent(), true, "a refused receipt leaves the intent unresolved");
    assert.equal(wal.heldMicro(), 15000n);
    closeWal(wal);

    // A hand-written confirmed receipt with no evidence is not replayed as settled.
    const lines = fs.readFileSync(walFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const { createHash } = await import("node:crypto");
    const forged = JSON.stringify({
      schema: "twzrd.svm_wal.v1",
      kind: "payment_receipt",
      intent_id: intent.intent_id,
      challenge_hash: HASH_A,
      tx_signature: null,
      status: "confirmed",
      slot: null,
      at_unix_ms: Date.now(),
      prev: createHash("sha256").update(lines[0]!).digest("hex"),
    });
    fs.appendFileSync(walFile, forged + "\n");
    assert.throws(() => createFileSvmWal(walFile), /payment_receipt/);
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* B4 — single WAL writer                                              */
/* ------------------------------------------------------------------ */

test("B4: a second WAL owner on the same file is refused and the chain stays intact", () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "svm-wal.jsonl");
    const first = createFileSvmWal(walFile);
    let second: ReturnType<typeof createFileSvmWal> | undefined;
    let secondAppended = false;
    try {
      second = createFileSvmWal(walFile);
    } catch (err) {
      assert.match(String(err), /wal_single_writer/);
    }
    first.appendIntent({
      challengeHash: HASH_A,
      paymentDecisionId: "dec_owner_1",
      payTo: SELLER,
      amountMicro: "1000",
      network: SOL,
    });
    if (second) {
      try {
        second.appendIntent({
          challengeHash: HASH_B,
          paymentDecisionId: "dec_owner_2",
          payTo: SELLER,
          amountMicro: "1000",
          network: SOL,
        });
        secondAppended = true;
      } catch (err) {
        assert.match(String(err), /wal_single_writer/);
      }
    }
    assert.equal(secondAppended, false, "a second owner must never append");
    assert.equal(second, undefined, "a second owner is refused when it opens the file");
    closeWal(first);

    // The file still replays: one intent, unbroken chain. Releasing the lock lets the next owner in.
    const reopened = createFileSvmWal(walFile);
    assert.equal(reopened.unresolvedIntents().length, 1);
    closeWal(reopened);
  } finally {
    rm(dir);
  }
});

test("B4: a stale lock from a dead pid is taken over; a live foreign owner is refused", () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "svm-wal.jsonl");
    const lockFile = `${walFile}.lock`;

    // pid 1 is alive and is not this process.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, instance_id: "foreign", instanceId: "foreign" }) + "\n");
    assert.throws(() => createFileSvmWal(walFile), /wal_single_writer/);
    assert.equal(fs.existsSync(lockFile), true, "a live owner's lock is left alone");

    // An unreadable lock is treated as held, never as free.
    fs.writeFileSync(lockFile, "{not json");
    assert.throws(() => createFileSvmWal(walFile), /wal_single_writer/);

    // A pid that cannot exist: the previous owner is gone, the lock is stale.
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 2_147_483_646, instance_id: "dead", instanceId: "dead" }) + "\n",
    );
    const wal = createFileSvmWal(walFile);
    wal.appendIntent({
      challengeHash: HASH_A,
      paymentDecisionId: "dec_takeover",
      payTo: SELLER,
      amountMicro: "1000",
      network: SOL,
    });
    assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid, process.pid);
    closeWal(wal);
    assert.equal(fs.existsSync(lockFile), false, "close() releases the lock");
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* B5 — cap-trip pause and opt-in block pause                          */
/* ------------------------------------------------------------------ */

const APPROVE_CFG = {
  intelBase: "https://intel.example",
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
};

test("B5: a cumulative cap trip writes .pause expiring with the budget window, never .kill", async () => {
  const dir = tmpDir();
  try {
    const ledger = createMemorySpendLedger();
    const WINDOW_MS = 365 * 24 * 3600 * 1000;
    const spentAt = Date.now() - 1_000_000;
    // 15000 already spent a little while ago, under every key this call checks.
    for (const key of ["agent:default", `merchant:${SELLER}`, "mandate:default"]) {
      ledger.record(key, 15000n, spentAt);
    }
    let signerCalls = 0;
    const before = Date.now();
    const res = await spendControlSafeFetch("https://merchant.example/api/v1", {
      stateDir: dir,
      ledger,
      maxSpend: "0.02",
      decisionId: "dec_cap_trip",
      fetch: fetchChallenge("10000"),
      pay: async () => {
        signerCalls += 1;
        return settled("captrip");
      },
    });
    assert.equal(res.verdict, "block");
    assert.equal(res.reason, "over_cumulative_spend");
    assert.equal(signerCalls, 0);

    assert.equal(fs.existsSync(path.join(dir, ".kill")), false, "a cap trip never writes a TTL-less .kill");
    const pause = JSON.parse(fs.readFileSync(path.join(dir, ".pause"), "utf8"));
    assert.equal(pause.schema, "twzrd.pause_sentinel.v1");
    assert.equal(pause.reason, "over_cumulative_spend");
    assert.equal(typeof pause.until_unix_ms, "number");
    // The window frees room when the 15000 entry ages out: spentAt + window.
    const windowEnd = spentAt + WINDOW_MS;
    assert.ok(pause.until_unix_ms > before, "the pause is in the future");
    assert.ok(
      Math.abs(pause.until_unix_ms - windowEnd) <= 5_000,
      `pause must end with the budget window (got ${pause.until_unix_ms}, window ends ${windowEnd})`,
    );

    // While it is active, the next call is vetoed by the sentinel before anything else.
    const next = await spendControlSafeFetch("https://merchant.example/api/v1", {
      stateDir: dir,
      ledger,
      maxSpend: "0.02",
      fetch: fetchChallenge("1"),
      pay: async () => settled("paused"),
    });
    assert.equal(next.verdict, "block");
    assert.equal(next.reason, "twzrd_payment_paused");
  } finally {
    rm(dir);
  }
});

test("B5: a retry of a settled challenge at the cap returns its receipt and does not pause; nothing is written without a sentinel location", async () => {
  const dir = tmpDir();
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir);
  try {
    const wal = createFileSvmWal(path.join(dir, "svm-wal.jsonl"));
    const ledger = createMemorySpendLedger();
    let signerCalls = 0;
    const payWholeCap = () =>
      spendControlSafeFetch("https://merchant.example/api/v1", {
        stateDir,
        svmWal: wal,
        ledger,
        maxSpend: "0.02",
        decisionId: "dec_whole_cap",
        fetch: fetchChallenge("20000"),
        pay: async () => {
          signerCalls += 1;
          return settled("wholecap");
        },
      });
    assert.equal((await payWholeCap()).verdict, "allow");

    // The cap is now full. Retrying the SAME challenge is a replay, not a cap trip.
    const replay = await payWholeCap();
    assert.equal(replay.verdict, "allow");
    assert.equal(replay.signerInvocations, 0);
    assert.equal(replay.txSignature, sig("wholecap"));
    assert.equal(signerCalls, 1);
    assert.equal(fs.existsSync(path.join(stateDir, ".pause")), false, "a replay must not pause both planes");

    // A new payment at the full cap with no sentinel location configured: refused,
    // and no .pause appears next to the WAL, in the state dir, or in the cwd default.
    const cwdPause = path.resolve("data", ".pause");
    const cwdPauseBefore = fs.existsSync(cwdPause);
    const prevEnv = process.env.TWZRD_STATE_DIR;
    delete process.env.TWZRD_STATE_DIR;
    try {
      const unlocated = await spendControlSafeFetch("https://merchant.example/api/new", {
        svmWal: wal,
        ledger,
        maxSpend: "0.02",
        decisionId: "dec_no_location",
        fetch: fetchChallenge("1", "https://merchant.example/api/new"),
        pay: async () => settled("nolocation"),
      });
      assert.equal(unlocated.reason, "over_cumulative_spend");
      assert.equal(unlocated.signerInvocations, 0);
    } finally {
      if (prevEnv !== undefined) process.env.TWZRD_STATE_DIR = prevEnv;
    }
    assert.equal(fs.existsSync(path.join(dir, ".pause")), false, "no sentinel is guessed next to the WAL");
    assert.equal(fs.existsSync(path.join(stateDir, ".pause")), false);
    assert.equal(fs.existsSync(cwdPause), cwdPauseBefore, "the cwd default is read, never written");

    // The same new payment with the location configured is the real trip.
    const tripped = await spendControlSafeFetch("https://merchant.example/api/new", {
      stateDir,
      svmWal: wal,
      ledger,
      maxSpend: "0.02",
      decisionId: "dec_located",
      fetch: fetchChallenge("1", "https://merchant.example/api/new"),
      pay: async () => settled("located"),
    });
    assert.equal(tripped.reason, "over_cumulative_spend");
    const pause = JSON.parse(fs.readFileSync(path.join(stateDir, ".pause"), "utf8"));
    assert.equal(pause.reason, "over_cumulative_spend");
    assert.equal(pause.decision_id, "dec_located");
    assert.equal(fs.existsSync(path.join(stateDir, ".kill")), false);
    closeWal(wal);
  } finally {
    rm(dir);
  }
});

test("B5: tripPauseOnBlockMs is off by default and, when set, fires on fatal refusals only", async () => {
  const dir = tmpDir();
  try {
    const pausePath = path.join(dir, ".pause");
    const intel = (card: Record<string, unknown>, status = 200): typeof fetch =>
      (async () =>
        new Response(JSON.stringify({ readiness_card: card }), { status })) as unknown as typeof fetch;
    const blockCard = { decision: "block", trust_score: 10, can_spend: false };
    const ctx = { sellerWallet: SELLER, priceUsdc: 0.05, chain: SOL, asset: USDC };

    // Default (unset): a blocked seller is refused and nothing is paused.
    const unset = await twzrdApprovePayment(ctx, { ...APPROVE_CFG, fetch: intel(blockCard), stateDir: dir });
    assert.equal(unset.approved, false);
    assert.equal(fs.existsSync(pausePath), false, "tripPauseOnBlockMs is off unless configured");

    // Same default on safeFetch: a per-call cap refusal and an intel block write nothing.
    const overMax = await spendControlSafeFetch("https://merchant.example/api/v1", {
      stateDir: dir,
      maxSpend: "0.001",
      ledger: createMemorySpendLedger(),
      fetch: fetchChallenge("10000"),
    });
    assert.equal(overMax.reason, "over_max_spend");
    const intelBlock = await spendControlSafeFetch("https://merchant.example/api/v1", {
      stateDir: dir,
      ledger: createMemorySpendLedger(),
      fetch: fetchChallenge("10000"),
      preflight: async () => ({ decision: "block" }),
    });
    assert.equal(intelBlock.reason, "intel_block");
    assert.equal(fs.existsSync(pausePath), false);

    // Opted in, non-fatal refusals still write nothing: an outage, a malformed
    // challenge, an unidentifiable recipient.
    const outage = await twzrdApprovePayment(ctx, {
      ...APPROVE_CFG,
      fetch: (async () => {
        throw new Error("intel unreachable");
      }) as unknown as typeof fetch,
      stateDir: dir,
      tripPauseOnBlockMs: 60_000,
    });
    assert.equal(outage.approved, false);
    assert.match(outage.reason, /^twzrd_fail_closed/);
    const noRecipient = await twzrdApprovePayment(
      { priceUsdc: 0.05, chain: SOL, asset: USDC },
      { ...APPROVE_CFG, fetch: intel(blockCard), stateDir: dir, tripPauseOnBlockMs: 60_000 },
    );
    assert.equal(noRecipient.reason, "twzrd_unidentifiable_payment_recipient");
    const malformed = await spendControlSafeFetch("https://merchant.example/api/v1", {
      stateDir: dir,
      tripPauseOnBlockMs: 60_000,
      fetch: (async () => new Response("not json", { status: 402 })) as unknown as typeof fetch,
    });
    assert.equal(malformed.reason, "unparseable_402");
    assert.equal(fs.existsSync(pausePath), false, "non-fatal refusals never trip the pause");

    // Opted in, a fatal refusal (the seller is blocked) writes .pause with the configured TTL.
    const before = Date.now();
    const fatal = await twzrdApprovePayment(ctx, {
      ...APPROVE_CFG,
      fetch: intel(blockCard),
      stateDir: dir,
      tripPauseOnBlockMs: 60_000,
    });
    assert.equal(fatal.approved, false);
    const pause = JSON.parse(fs.readFileSync(pausePath, "utf8"));
    assert.equal(pause.reason, "twzrd_decision_block");
    assert.equal(pause.decision_id, fatal.decisionId);
    assert.ok(pause.until_unix_ms >= before + 60_000 && pause.until_unix_ms <= Date.now() + 60_000);
    assert.equal(fs.existsSync(path.join(dir, ".kill")), false);
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* B6 / B7 / B8                                                        */
/* ------------------------------------------------------------------ */

test("B6: a pre-sign payment_intent row cannot carry tx_signature", () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "svm-wal.jsonl");
    const wal = createFileSvmWal(walFile);
    assert.throws(
      () =>
        wal.appendIntent({
          challengeHash: HASH_A,
          paymentDecisionId: "dec_presign",
          payTo: SELLER,
          amountMicro: "1000",
          network: SOL,
          txSignature: sig("presign"),
        } as never),
      /tx_signature/,
    );
    assert.equal(fs.existsSync(walFile) ? fs.readFileSync(walFile, "utf8") : "", "", "nothing was written");
    const row = wal.appendIntent({
      challengeHash: HASH_A,
      paymentDecisionId: "dec_presign",
      payTo: SELLER,
      amountMicro: "1000",
      network: SOL,
    });
    assert.equal("tx_signature" in row, false);
    closeWal(wal);

    // A file whose intent row claims a signature is refused on replay.
    const forgedFile = path.join(dir, "forged-wal.jsonl");
    fs.writeFileSync(
      forgedFile,
      JSON.stringify({
        schema: "twzrd.svm_wal.v1",
        kind: "payment_intent",
        intent_id: "int_forged",
        challenge_hash: HASH_A,
        payment_decision_id: "dec_forged",
        pay_to: SELLER,
        amount_micro: "1000",
        network: SOL,
        tx_signature: sig("forged"),
        at_unix_ms: 1_700_000_000_000,
        prev: "genesis",
      }) + "\n",
    );
    assert.throws(() => createFileSvmWal(forgedFile), /tx_signature/);
  } finally {
    rm(dir);
  }
});

test("B7: parseBindingPolicy defaults to the caller's own (payment) section", () => {
  const envelope = {
    schema: "twzrd.binding_policy.v1",
    state_dir: "./state",
    compute: { max_usd_per_hour: "not-a-number", surprise_key: true },
    payment: { max_spend_usdc: "0.02" },
  };
  // The payment gate reads its own section: a broken compute section is the sibling's problem.
  const parsed = bindingPlane.parseBindingPolicy(envelope);
  assert.equal(parsed.payment?.max_spend_usdc, "0.02");
  assert.equal(parsed.compute, undefined, "the sibling section is not parsed by default");
  // Its own section still fails closed.
  assert.throws(
    () => bindingPlane.parseBindingPolicy({ ...envelope, payment: { max_spend_usdc: "lots" } }),
    /max_spend_usdc/,
  );
  // Whole-envelope validation stays available, explicitly.
  assert.throws(() => bindingPlane.parseBindingPolicy(envelope, { section: "all" }), /compute/);
});

test("B8: the WAL module makes no enclave or custody claim", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "..", "src", "svm-wal.ts"), "utf8");
  assert.doesNotMatch(source, /enclave/i);
  assert.doesNotMatch(source, /custod/i);
});
