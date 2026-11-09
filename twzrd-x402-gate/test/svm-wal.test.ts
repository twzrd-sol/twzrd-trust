import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SVM_WAL_SCHEMA,
  createFileSvmWal,
  sharedFileSvmWal,
  __resetSharedFileSvmWals,
} from "../src/svm-wal.js";
import { spendControlSafeFetch } from "../src/spend-control.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CHALLENGE_HASH_1 = "a".repeat(64);
const CHALLENGE_HASH_2 = "b".repeat(64);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gate-svm-wal-"));
}

function challengeResponse(amount = "10000", resource = "https://merchant.example/api/v1") {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: SOL,
          payTo: SELLER,
          maxAmountRequired: amount,
          asset: USDC,
          resource,
        },
      ],
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  );
}

test("SvmWal writes hash-chained payment_intent and payment_receipt rows with fsync before state transitions", () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "svm-wal.jsonl");
    let fsyncCount = 0;
    const wal = createFileSvmWal(walFile, {
      fsyncFn: (fd) => {
        fs.fsyncSync(fd);
        fsyncCount += 1;
      },
    });

    const intent = wal.appendIntent({
      challengeHash: CHALLENGE_HASH_1,
      paymentDecisionId: "dec_wal_1",
      payTo: SELLER,
      amountMicro: "25000",
      network: SOL,
      lastValidBlockHeight: 300_000_000,
      atUnixMs: 1_700_000_000_000,
    });
    assert.equal(intent.schema, SVM_WAL_SCHEMA);
    assert.equal(intent.kind, "payment_intent");
    assert.equal(intent.prev, "genesis");
    assert.equal("tx_signature" in intent, false, "Lock 11: pre-sign payment_intent must not have tx_signature");
    assert.equal(fsyncCount, 1);
    assert.equal(wal.hasUnresolvedIntent(), true);
    assert.equal(wal.heldMicro(), 25000n);

    // While unresolved, a second appendIntent is refused
    assert.throws(
      () =>
        wal.appendIntent({
          challengeHash: CHALLENGE_HASH_2,
          paymentDecisionId: "dec_wal_2",
          payTo: SELLER,
          amountMicro: "10000",
          network: SOL,
        }),
      /wal_unresolved_intent/,
    );

    const receipt = wal.appendReceipt({
      intentId: intent.intent_id,
      status: "confirmed",
      txSignature: "5SigWalTest1111111111111111111111111111111111",
      slot: 312_345_678,
      atUnixMs: 1_700_000_005_000,
    });
    assert.equal(receipt.schema, SVM_WAL_SCHEMA);
    assert.equal(receipt.kind, "payment_receipt");
    assert.notEqual(receipt.prev, "genesis");
    assert.equal(fsyncCount, 2);
    assert.equal(wal.hasUnresolvedIntent(), false);
    assert.equal(wal.heldMicro(), 0n);
    assert.equal(wal.confirmedMicro(), 25000n);

    // Re-open from disk: replays hash chain and preserves confirmed lookup
    const replayed = createFileSvmWal(walFile);
    assert.equal(replayed.hasUnresolvedIntent(), false);
    assert.equal(replayed.confirmedMicro(), 25000n);
    const lookup = replayed.lookupChallenge(CHALLENGE_HASH_1);
    assert.equal(lookup.state, "confirmed");
    if (lookup.state === "confirmed") {
      assert.equal(lookup.receipt.tx_signature, "5SigWalTest1111111111111111111111111111111111");
      assert.equal(lookup.receipt.slot, 312_345_678);
    }
    wal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Lock 11 & Lock 14: payment_intent rejects tx_signature, and source does not claim callback is a signing enclave", () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "lock11-wal.jsonl");
    const wal = createFileSvmWal(walFile);
    assert.throws(
      () =>
        wal.appendIntent({
          challengeHash: CHALLENGE_HASH_1,
          paymentDecisionId: "dec_lock11",
          payTo: SELLER,
          amountMicro: "10000",
          network: SOL,
          ...({ txSignature: "5IllegalPreSignSig" } as Record<string, unknown>),
        }),
      /must not carry tx_signature before signing/i,
    );
    wal.close();

    // Also reject a payment_intent row on disk that carries tx_signature
    const diskWalFile = path.join(dir, "lock11-disk-wal.jsonl");
    fs.writeFileSync(
      diskWalFile,
      JSON.stringify({
        schema: SVM_WAL_SCHEMA,
        kind: "payment_intent",
        intent_id: "int_bad_1",
        challenge_hash: CHALLENGE_HASH_1,
        payment_decision_id: "dec_1",
        pay_to: SELLER,
        amount_micro: "1000",
        network: SOL,
        tx_signature: "5IllegalDiskSig",
        at_unix_ms: 1000,
        prev: "genesis",
      }) + "\n",
    );
    assert.throws(() => createFileSvmWal(diskWalFile), /must not carry tx_signature before signing/i);

    // Lock 14: source does not call the in-process callback a "signing enclave"
    const walSrcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/svm-wal.ts");
    const walSrc = fs.readFileSync(walSrcPath, "utf8");
    assert.doesNotMatch(walSrc, /signing enclave/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-sign fsync failure aborts before the signing key is invoked (signerInvocations === 0)", async () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "fail-wal.jsonl");
    const failingWal = createFileSvmWal(walFile, {
      fsyncFn: () => {
        const err = new Error("EIO: i/o error on fsync") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      },
    });

    let signerCalls = 0;
    const res = await spendControlSafeFetch("https://merchant.example/api/v1", {
      svmWal: failingWal,
      decisionId: "dec_fsync_fail",
      fetch: (async () => challengeResponse("10000")) as unknown as typeof fetch,
      pay: async () => {
        signerCalls += 1;
        return {
          txSignature: "5ShouldNeverSign1111111111111111111111111111",
          slot: 100,
          response: new Response("paid", { status: 200 }),
        };
      },
    });

    assert.equal(res.verdict, "block");
    assert.equal(res.reason, "wal_intent_write_failed");
    assert.equal(res.signerInvocations, 0);
    assert.equal(signerCalls, 0, "payer callback must never be called when WAL fsync fails");
    failingWal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Hole 2 & crash recovery: recovered confirmed spend counts against maxSpend cap and prevents overspend", async () => {
  const dir = tmpDir();
  try {
    __resetSharedFileSvmWals();
    const walFile = path.join(dir, "crash-wal.jsonl");

    // 1. First call ($0.015) signs and broadcasts, then throws (simulating process death/network drop before receipt)
    let signerCalls = 0;
    await assert.rejects(
      () =>
        spendControlSafeFetch("https://merchant.example/api/v1", {
          svmWalFile: walFile,
          maxSpend: "0.020",
          decisionId: "dec_crash_1",
          fetch: (async () => challengeResponse("15000")) as unknown as typeof fetch,
          pay: async () => {
            signerCalls += 1;
            throw new Error("RPC connection lost after broadcast");
          },
        }),
      /RPC connection lost after broadcast/,
    );
    assert.equal(signerCalls, 1);

    // 2. Process restarts (clear in-memory cache and reload WAL from disk)
    __resetSharedFileSvmWals();
    const reloadedWal = sharedFileSvmWal(walFile);
    assert.equal(reloadedWal.hasUnresolvedIntent(), true);
    assert.equal(reloadedWal.heldMicro(), 15000n);

    // 3. Any new payment attempt while unresolved is refused before signing (wal_unresolved_intent)
    const blocked = await spendControlSafeFetch("https://merchant.example/api/v2", {
      svmWal: reloadedWal,
      maxSpend: "0.020",
      decisionId: "dec_after_crash",
      fetch: (async () => challengeResponse("5000", "https://merchant.example/api/v2")) as unknown as typeof fetch,
      pay: async () => {
        signerCalls += 1;
        return {
          txSignature: "5ShouldNotRun",
          slot: 1,
          response: new Response("paid", { status: 200 }),
        };
      },
    });
    assert.equal(blocked.verdict, "block");
    assert.equal(blocked.reason, "wal_unresolved_intent");
    assert.equal(blocked.signerInvocations, 0);
    assert.equal(signerCalls, 1, "signer must not run while an unresolved intent exists");

    // 4. RPC recovery polls Pending first -> loop stays frozen
    const pendingRec = await reloadedWal.recoverUnresolvedIntents(async () => ({
      status: "pending",
    }));
    assert.equal(pendingRec.resolved, 0);
    assert.equal(reloadedWal.hasUnresolvedIntent(), true);

    // 5. RPC recovery observes finalized transaction on chain ($0.015) -> writes payment_receipt and unfreezes loop
    const confirmedSig = "5RecoveredSigFromRpc1111111111111111111111111";
    const resolvedRec = await reloadedWal.recoverUnresolvedIntents(async (intent) => {
      assert.equal(intent.payment_decision_id, "dec_crash_1");
      return {
        status: "confirmed",
        txSignature: confirmedSig,
        slot: 320_000_001,
      };
    });
    assert.equal(resolvedRec.resolved, 1);
    assert.equal(reloadedWal.hasUnresolvedIntent(), false);
    assert.equal(reloadedWal.heldMicro(), 0n);
    assert.equal(reloadedWal.confirmedMicro(), 15000n);

    // 6. Hole 2: Requesting $0.010 (10,000 micro-USDC) under a $0.020 (20,000 micro-USDC) cap after recovering $0.015 (15,000) MUST be blocked ($0.025 > $0.020)!
    const overspendAttempt = await spendControlSafeFetch("https://merchant.example/api/v3", {
      svmWal: reloadedWal,
      maxSpend: "0.020",
      decisionId: "dec_overspend_after_recovery",
      fetch: (async () => challengeResponse("10000", "https://merchant.example/api/v3")) as unknown as typeof fetch,
      pay: async () => {
        signerCalls += 1;
        return {
          txSignature: "5OverspendSig",
          slot: 320_000_002,
          response: new Response("paid", { status: 200 }),
        };
      },
    });
    assert.equal(overspendAttempt.verdict, "block");
    assert.equal(overspendAttempt.reason, "over_cumulative_spend");
    assert.equal(overspendAttempt.signerInvocations, 0);
    assert.equal(signerCalls, 1, "recovered $0.015 + new $0.010 must be blocked under $0.020 cap");

    // 7. Retrying the exact same confirmed challenge + decisionId returns the confirmed signature idempotently with 0 signer calls
    const idempotent = await spendControlSafeFetch("https://merchant.example/api/v1", {
      svmWal: reloadedWal,
      decisionId: "dec_crash_1",
      fetch: (async () => challengeResponse("15000")) as unknown as typeof fetch,
      pay: async () => {
        signerCalls += 1;
        return {
          txSignature: "5DupSig",
          slot: 320_000_003,
          response: new Response("paid-again", { status: 200 }),
        };
      },
    });
    assert.equal(idempotent.verdict, "allow");
    assert.equal(idempotent.signerInvocations, 0, "confirmed intent must not re-invoke signer");
    assert.equal(idempotent.txSignature, confirmedSig);
    assert.equal(signerCalls, 1);
  } finally {
    __resetSharedFileSvmWals();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Hole 3: single-writer lock prevents concurrent process or instance writes from breaking the WAL hash chain", () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "locked-wal.jsonl");
    const wal1 = createFileSvmWal(walFile);
    const intent1 = wal1.appendIntent({
      challengeHash: CHALLENGE_HASH_1,
      paymentDecisionId: "dec_lock_1",
      payTo: SELLER,
      amountMicro: "5000",
      network: SOL,
    });
    wal1.appendReceipt({
      intentId: intent1.intent_id,
      status: "confirmed",
      txSignature: "5SigLock111111111111111111111111111111111111",
      slot: 101,
    });

    // 1. A second process attempting to open or write to walFile while wal1 holds the lock is refused
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `
        import { createFileSvmWal } from ${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/svm-wal.ts"))};
        const w = createFileSvmWal(${JSON.stringify(walFile)});
        w.appendIntent({
          challengeHash: ${JSON.stringify(CHALLENGE_HASH_2)},
          paymentDecisionId: "dec_child",
          payTo: ${JSON.stringify(SELLER)},
          amountMicro: "5000",
          network: ${JSON.stringify(SOL)},
        });
        `,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(child.status, 0, "second process must be refused by single-writer lock");
    assert.match(child.stderr, /wal_single_writer_lock/);

    // 2. Two instances in the same process: stale instance cannot overwrite after newer instance advances the file
    const staleInstance = createFileSvmWal(walFile);
    const intent2 = wal1.appendIntent({
      challengeHash: CHALLENGE_HASH_2,
      paymentDecisionId: "dec_lock_2",
      payTo: SELLER,
      amountMicro: "5000",
      network: SOL,
    });
    wal1.appendReceipt({
      intentId: intent2.intent_id,
      status: "confirmed",
      txSignature: "5SigLock222222222222222222222222222222222222",
      slot: 102,
    });
    assert.throws(
      () =>
        staleInstance.appendIntent({
          challengeHash: "c".repeat(64),
          paymentDecisionId: "dec_stale",
          payTo: SELLER,
          amountMicro: "5000",
          network: SOL,
        }),
      /wal_single_writer_lock/,
    );

    wal1.close();

    // 3. Reopening the WAL succeeds cleanly with an unbroken hash chain
    const reopened = createFileSvmWal(walFile);
    assert.equal(reopened.confirmedMicro(), 10000n);
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Hole 4: an empty payer callback response without txSignature and slot is refused and never gets a confirmed receipt", async () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "unconfirmed-wal.jsonl");
    const wal = createFileSvmWal(walFile);

    // 1. Direct appendReceipt with status="confirmed" and missing signature/slot throws
    const directIntent = wal.appendIntent({
      challengeHash: CHALLENGE_HASH_1,
      paymentDecisionId: "dec_direct_unconfirmed",
      payTo: SELLER,
      amountMicro: "10000",
      network: SOL,
    });
    assert.throws(
      () =>
        wal.appendReceipt({
          intentId: directIntent.intent_id,
          status: "confirmed",
          txSignature: null,
          slot: null,
        }),
      /confirmed payment_receipt requires non-empty tx_signature and positive integer slot/i,
    );
    wal.close();

    // 2. spendControlSafeFetch with an empty payer response ({} or missing txSignature/slot) refuses with wal_unconfirmed_payment and leaves intent pending
    const walFile2 = path.join(dir, "unconfirmed-fetch-wal.jsonl");
    const wal2 = createFileSvmWal(walFile2);
    const res = await spendControlSafeFetch("https://merchant.example/api/v1", {
      svmWal: wal2,
      decisionId: "dec_empty_pay",
      fetch: (async () => challengeResponse("10000")) as unknown as typeof fetch,
      pay: async () => ({
        response: new Response("paid-without-chain-proof", { status: 200 }),
      }),
    });
    assert.equal(res.verdict, "block");
    assert.equal(res.reason, "wal_unconfirmed_payment");
    assert.equal(res.signerInvocations, 1);
    assert.equal(wal2.hasUnresolvedIntent(), true, "intent must stay unresolved when payer returned no signature/slot");
    assert.equal(wal2.confirmedMicro(), 0n, "unverified payment must not be marked confirmed");
    wal2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("expired blockhash recovery releases the held budget so a fresh attempt can sign", async () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "expired-wal.jsonl");
    const wal = createFileSvmWal(walFile);

    const intent = wal.appendIntent({
      challengeHash: CHALLENGE_HASH_1,
      paymentDecisionId: "dec_exp_1",
      payTo: SELLER,
      amountMicro: "20000",
      network: SOL,
      lastValidBlockHeight: 100,
    });
    assert.equal(wal.hasUnresolvedIntent(), true);
    assert.equal(wal.heldMicro(), 20000n);

    // Recovery determines blockhash expired without landing
    const rec = await wal.recoverUnresolvedIntents(async () => ({
      status: "expired_blockhash",
      txSignature: null,
      slot: null,
    }));
    assert.equal(rec.resolved, 1);
    assert.equal(wal.hasUnresolvedIntent(), false);
    assert.equal(wal.heldMicro(), 0n);
    assert.equal(wal.confirmedMicro(), 0n);

    const lookup = wal.lookupChallenge(CHALLENGE_HASH_1);
    assert.equal(lookup.state, "failed");
    assert.equal(intent.intent_id.length > 0, true);

    // A new attempt on the same challengeHash can now proceed and sign
    const retryIntent = wal.appendIntent({
      challengeHash: CHALLENGE_HASH_1,
      paymentDecisionId: "dec_exp_2",
      payTo: SELLER,
      amountMicro: "20000",
      network: SOL,
      lastValidBlockHeight: 250,
    });
    assert.notEqual(retryIntent.intent_id, intent.intent_id);
    assert.equal(wal.hasUnresolvedIntent(), true);
    wal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt or chain-broken WAL file fails closed on open", () => {
  const dir = tmpDir();
  try {
    const walFile = path.join(dir, "corrupt-wal.jsonl");
    fs.writeFileSync(walFile, '{"schema":"twzrd.svm_wal.v1","kind":"payment_intent"\n');
    assert.throws(() => createFileSvmWal(walFile), /corrupt row/i);

    const badChainFile = path.join(dir, "bad-chain-wal.jsonl");
    fs.writeFileSync(
      badChainFile,
      JSON.stringify({
        schema: "twzrd.svm_wal.v1",
        kind: "payment_intent",
        intent_id: "int_1",
        challenge_hash: CHALLENGE_HASH_1,
        payment_decision_id: "dec_1",
        pay_to: SELLER,
        amount_micro: "1000",
        network: SOL,
        at_unix_ms: 1000,
        prev: "wrong_prev_hash",
      }) + "\n",
    );
    assert.throws(() => createFileSvmWal(badChainFile), /chain broken/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bindingPolicyToSpendControlOptions maps svm_wal_file and unresolved WAL heldMicro counts against maxSpend", async () => {
  const { parseBindingPolicy, bindingPolicyToSpendControlOptions } = await import(
    "../src/binding-plane.js"
  );
  const dir = tmpDir();
  try {
    const policy = parseBindingPolicy({
      schema: "twzrd.binding_policy.v1",
      state_dir: "./state",
      payment: {
        max_spend_usdc: "0.02",
        svm_wal_file: "./state/custom-svm-wal.jsonl",
      },
    });
    const opts = bindingPolicyToSpendControlOptions(policy, dir);
    assert.equal(opts.svmWalFile, path.resolve(dir, "state", "custom-svm-wal.jsonl"));

    // Seed an unresolved 15,000 micro-USDC intent in a WAL; a 10,000 micro-USDC request against maxSpend=0.02 (20,000) is blocked by over_cumulative_spend before wal_unresolved_intent
    const wal = createFileSvmWal(opts.svmWalFile!);
    wal.appendIntent({
      challengeHash: CHALLENGE_HASH_1,
      paymentDecisionId: "dec_held_1",
      payTo: SELLER,
      amountMicro: "15000",
      network: SOL,
    });

    const overCap = await spendControlSafeFetch("https://merchant.example/api/v2", {
      ...opts,
      svmWal: wal,
      fetch: (async () => challengeResponse("10000", "https://merchant.example/api/v2")) as unknown as typeof fetch,
      pay: async () => ({
        txSignature: "5Sig",
        slot: 1,
        response: new Response("paid", { status: 200 }),
      }),
    });
    assert.equal(overCap.verdict, "block");
    assert.equal(overCap.reason, "over_cumulative_spend");
    assert.equal(overCap.signerInvocations, 0);
    wal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
