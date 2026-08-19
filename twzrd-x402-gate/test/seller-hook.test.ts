/**
 * Seller-side pre-settlement guard — payer extraction + veto policy + fail-open.
 * Run: npx tsx test/seller-hook.test.ts
 */
import assert from "node:assert/strict";

import {
  createTwzrdSettleGuard,
  defaultExtractPayer,
  extractSvmPayerFromTransaction,
  twzrdPayerScreen,
  toPayaiVerifyResult,
  type PayerScreen,
  type SettleGuardContext,
} from "../src/seller-hook.js";
import { EXACT_SVM_TRANSFER_CHECKED_FIXTURE as SVM_FIXTURE } from "./fixtures/exact-svm-transfer-checked.js";

/** Mock fetch that serves /v1/intel/merchant_card/{wallet}. */
function merchantFetch(cardByWallet: Record<string, unknown | null>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const m = url.match(/\/v1\/intel\/merchant_card\/([^/?]+)/);
    const wallet = m ? decodeURIComponent(m[1]) : "";
    const card = cardByWallet[wallet];
    if (card === null || card === undefined) throw new Error("merchant card down");
    return new Response(JSON.stringify(card), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const ctxWith = (payload: Record<string, unknown>): SettleGuardContext => ({
  paymentPayload: { payload },
  requirements: {},
});

async function run() {
  // ---------- defaultExtractPayer (authoritative first) ----------
  assert.equal(await defaultExtractPayer(ctxWith({ payer: "PAY1" })), "PAY1", "payload.payer");
  assert.equal(await defaultExtractPayer(ctxWith({ from: "PAY2" })), "PAY2", "payload.from");
  assert.equal(
    await defaultExtractPayer(ctxWith({ authorization: { from: "PAY3" } })),
    "PAY3",
    "payload.authorization.from (exact-evm EIP-3009)",
  );
  assert.equal(
    await defaultExtractPayer(ctxWith({ permit2Authorization: { from: "PAY_P2" } })),
    "PAY_P2",
    "payload.permit2Authorization.from (exact-evm Permit2)",
  );
  assert.equal(await defaultExtractPayer(ctxWith({ account: "PAY4" })), "PAY4", "payload.account");
  assert.equal(
    await defaultExtractPayer({ payer: "FLAT" } as SettleGuardContext),
    "FLAT",
    "PayAI flat ctx.payer",
  );
  assert.equal(await defaultExtractPayer(ctxWith({ nope: 1 })), null, "no payer -> null");
  assert.equal(await defaultExtractPayer({} as SettleGuardContext), null, "empty ctx -> null");
  assert.equal(await defaultExtractPayer(ctxWith({ payer: "  " })), null, "blank string -> null");

  // P1: signed authorization.from MUST beat spoofed payload.payer
  assert.equal(
    await defaultExtractPayer(
      ctxWith({ payer: "CLEAN_ALIAS", authorization: { from: "SIGNED_WASH" } }),
    ),
    "SIGNED_WASH",
    "spoof: signed authorization.from beats payload.payer",
  );
  assert.equal(
    await defaultExtractPayer(
      ctxWith({ from: "CLEAN_ALIAS", permit2Authorization: { from: "SIGNED_P2" } }),
    ),
    "SIGNED_P2",
    "spoof: signed permit2Authorization.from beats payload.from",
  );
  // Authoritative SVM shape present but unrecoverable -> null, never alias
  assert.equal(
    await defaultExtractPayer(
      ctxWith({ payer: "CLEAN_ALIAS", transaction: "not-a-real-tx" }),
    ),
    null,
    "spoof: SVM transaction shape ignores payload.payer when decode fails",
  );

  // ---------- exact-SVM real fixture (optional peer @x402/svm) ----------
  let svmPeerAvailable = false;
  try {
    await import("@x402/svm");
    svmPeerAvailable = true;
  } catch {
    svmPeerAvailable = false;
  }

  if (svmPeerAvailable) {
    const fromTx = await extractSvmPayerFromTransaction(SVM_FIXTURE.transactionBase64);
    assert.ok(fromTx && fromTx.length > 0, "fixture decode yields non-empty payer");
    assert.equal(
      fromTx,
      SVM_FIXTURE.expectedTokenPayer,
      "fixture token payer matches frozen expectedTokenPayer",
    );
    console.log(`svm_fixture_payer=${fromTx}`);

    // Anti-alias: spoofed payload.payer must not win over payload.transaction
    const extracted = await defaultExtractPayer(
      ctxWith({
        payer: "CLEAN_ALIAS_SHOULD_NOT_WIN",
        transaction: SVM_FIXTURE.transactionBase64,
      }),
    );
    assert.equal(
      extracted,
      SVM_FIXTURE.expectedTokenPayer,
      "real SVM fixture: transaction path beats spoofed payload.payer",
    );
    assert.notEqual(extracted, "CLEAN_ALIAS_SHOULD_NOT_WIN");
  } else {
    // Fail-soft: environments without the optional peer still green the suite.
    const skipped = await extractSvmPayerFromTransaction(SVM_FIXTURE.transactionBase64);
    assert.equal(
      skipped,
      null,
      "peer missing: extractSvmPayerFromTransaction returns null (fail-soft)",
    );
    // Authoritative shape present + unrecoverable -> null, not alias
    assert.equal(
      await defaultExtractPayer(
        ctxWith({
          payer: "CLEAN_ALIAS_SHOULD_NOT_WIN",
          transaction: SVM_FIXTURE.transactionBase64,
        }),
      ),
      null,
      "peer missing: SVM shape still ignores spoofed alias",
    );
    console.log("svm_peer_missing=true (fixture path skipped, suite continues)");
  }

  // ---------- veto policy (injected screen) ----------
  const guard = createTwzrdSettleGuard({
    screen: (payer): PayerScreen | null => {
      if (payer === "WASH") return { washFlagged: true };
      if (payer === "BLOCK") return { decision: "block" };
      if (payer === "WARN") return { decision: "warn" };
      if (payer === "CLEAN") return { washFlagged: false, decision: "allow" };
      return null;
    },
  });

  const washRes = await guard(ctxWith({ payer: "WASH" }));
  assert.ok(washRes && washRes.abort === true, "wash payer aborts");
  assert.equal(washRes && washRes.reason, "twzrd_payer_wash_flagged");

  const blockRes = await guard(ctxWith({ payer: "BLOCK" }));
  assert.ok(blockRes && blockRes.abort === true, "block payer aborts");
  assert.equal(blockRes && blockRes.reason, "twzrd_payer_block");

  const warnRes = await guard(ctxWith({ payer: "WARN" }));
  assert.equal(warnRes, undefined, "warn continues by default (not blocked)");

  const cleanRes = await guard(ctxWith({ payer: "CLEAN" }));
  assert.equal(cleanRes, undefined, "clean payer continues");

  const noSignal = await guard(ctxWith({ payer: "UNKNOWN" }));
  assert.equal(noSignal, undefined, "null screen fails open (continue)");

  const noPayer = await guard(ctxWith({ nope: 1 }));
  assert.equal(noPayer, undefined, "unresolved payer fails open (continue)");

  // Spoofed clean alias next to signed wash authorization is screened as WASH
  const spoofGuard = createTwzrdSettleGuard({
    screen: (payer): PayerScreen | null =>
      payer === "SIGNED_WASH" ? { washFlagged: true } : { washFlagged: false },
  });
  const spoofRes = await spoofGuard(
    ctxWith({ payer: "CLEAN_ALIAS", authorization: { from: "SIGNED_WASH" } }),
  );
  assert.ok(spoofRes && spoofRes.abort === true, "spoofed alias cannot bypass wash screen");
  assert.equal(spoofRes && spoofRes.reason, "twzrd_payer_wash_flagged");

  // ---------- abortOn.warn opt-in ----------
  const strictGuard = createTwzrdSettleGuard({
    screen: () => ({ decision: "warn" }),
    abortOn: { warn: true },
  });
  const warnAbort = await strictGuard(ctxWith({ payer: "WARN" }));
  assert.ok(warnAbort && warnAbort.abort === true, "abortOn.warn aborts warn payer");
  assert.equal(warnAbort && warnAbort.reason, "twzrd_payer_warn");

  // ---------- washFlagged opt-out ----------
  const noWashGuard = createTwzrdSettleGuard({
    screen: () => ({ washFlagged: true }),
    abortOn: { washFlagged: false },
  });
  assert.equal(
    await noWashGuard(ctxWith({ payer: "WASH" })),
    undefined,
    "abortOn.washFlagged=false ignores wash",
  );

  // ---------- fail-open vs fail-closed on screen error ----------
  const throwScreen = () => {
    throw new Error("screen exploded");
  };
  const failOpenGuard = createTwzrdSettleGuard({ screen: throwScreen });
  assert.equal(
    await failOpenGuard(ctxWith({ payer: "X" })),
    undefined,
    "screen error fails open by default",
  );
  const failClosedGuard = createTwzrdSettleGuard({ screen: throwScreen, failOpen: false });
  const fc = await failClosedGuard(ctxWith({ payer: "X" }));
  assert.ok(fc && fc.abort === true, "failOpen=false aborts on screen error");
  assert.equal(fc && fc.reason, "twzrd_screen_error");

  // failOpen:false must also abort on unresolved payer / null screen
  const fcUnresolved = createTwzrdSettleGuard({
    screen: () => ({ washFlagged: false }),
    failOpen: false,
  });
  const fcNoPayer = await fcUnresolved(ctxWith({ nope: 1 }));
  assert.ok(fcNoPayer && fcNoPayer.abort === true, "failOpen=false aborts on unresolved payer");
  assert.equal(fcNoPayer && fcNoPayer.reason, "twzrd_payer_unresolved");

  const fcNullScreen = createTwzrdSettleGuard({
    screen: () => null,
    failOpen: false,
  });
  const fcNull = await fcNullScreen(ctxWith({ payer: "X" }));
  assert.ok(fcNull && fcNull.abort === true, "failOpen=false aborts on null screen");
  assert.equal(fcNull && fcNull.reason, "twzrd_screen_unavailable");

  // ---------- timeout around hanging screen ----------
  const hang = () => new Promise<PayerScreen>(() => {}); // never resolves
  const hangOpen = createTwzrdSettleGuard({ screen: hang, timeoutMs: 30 });
  const t0 = Date.now();
  assert.equal(
    await hangOpen(ctxWith({ payer: "X" })),
    undefined,
    "hanging screen fails open after timeout",
  );
  assert.ok(Date.now() - t0 < 500, "timeout fires promptly");

  const hangClosed = createTwzrdSettleGuard({
    screen: hang,
    timeoutMs: 30,
    failOpen: false,
  });
  const hangFc = await hangClosed(ctxWith({ payer: "X" }));
  assert.ok(hangFc && hangFc.abort === true, "hanging screen fails closed when configured");
  assert.equal(hangFc && hangFc.reason, "twzrd_screen_timeout");

  // ---------- onDecision telemetry ----------
  const seen: Array<{ aborted: boolean; reason: string; payer: string | null }> = [];
  const teleGuard = createTwzrdSettleGuard({
    screen: () => ({ washFlagged: true }),
    onDecision: (i) => seen.push({ aborted: i.aborted, reason: i.reason, payer: i.payer }),
  });
  await teleGuard(ctxWith({ payer: "WASH" }));
  assert.equal(seen.length, 1, "onDecision fired once");
  assert.equal(seen[0].aborted, true);
  assert.equal(seen[0].reason, "twzrd_payer_wash_flagged");
  assert.equal(seen[0].payer, "WASH");

  // onDecision that throws must not break the payment path
  const badTele = createTwzrdSettleGuard({
    screen: () => ({ washFlagged: false }),
    onDecision: () => {
      throw new Error("telemetry sink down");
    },
  });
  assert.equal(
    await badTele(ctxWith({ payer: "CLEAN" })),
    undefined,
    "throwing onDecision is swallowed",
  );

  // ---------- custom getPayer ----------
  const customGuard = createTwzrdSettleGuard({
    getPayer: (c) => ((c as Record<string, unknown>).buyer as string) ?? null,
    screen: (payer) => (payer === "BUYER1" ? { washFlagged: true } : null),
  });
  const custom = await customGuard({ buyer: "BUYER1" } as SettleGuardContext);
  assert.ok(custom && custom.abort === true, "custom getPayer resolves + aborts");

  // ---------- twzrdPayerScreen reference (free merchant_card) ----------
  const refGuard = createTwzrdSettleGuard({
    screen: twzrdPayerScreen({
      intelBase: "https://intel.twzrd.xyz",
      fetch: merchantFetch({
        WASHPAYER: { merchant: "WASHPAYER", wash_flagged: true, in_corpus: true },
        CLEANPAYER: { merchant: "CLEANPAYER", wash_flagged: false, in_corpus: true },
        // GAPPAYER omitted -> fetch throws -> fetchMerchantCard null -> fail-open
      }),
    }),
  });
  const refWash = await refGuard(ctxWith({ payer: "WASHPAYER" }));
  assert.ok(refWash && refWash.abort === true, "merchant_card wash payer aborts");
  assert.equal(refWash && refWash.reason, "twzrd_payer_wash_flagged");
  assert.equal(
    await refGuard(ctxWith({ payer: "CLEANPAYER" })),
    undefined,
    "merchant_card clean payer continues",
  );
  assert.equal(
    await refGuard(ctxWith({ payer: "GAPPAYER" })),
    undefined,
    "merchant_card outage fails open (continue)",
  );

  // ---------- PayAI adapter ----------
  assert.deepEqual(
    toPayaiVerifyResult({ abort: true, reason: "twzrd_payer_wash_flagged" }),
    { reject: true, reason: "twzrd_payer_wash_flagged" },
    "abort -> PayAI reject object",
  );
  assert.equal(toPayaiVerifyResult(undefined), undefined, "continue -> no PayAI reject");

  console.log("seller-hook.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
