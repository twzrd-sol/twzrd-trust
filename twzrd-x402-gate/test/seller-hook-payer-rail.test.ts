/**
 * Seller settle guard: the payer screened is the payer that settles.
 *
 * An exact-SVM payment is a signed transaction; its payer is the transfer
 * authority inside it. The guard used to read `payload.authorization.from`
 * first, whatever the scheme, so a sender could add that unsigned field with a
 * clean wallet and have the guard screen the clean wallet while the signed
 * transaction paid from a flagged one.
 *
 * Run: npx tsx --test test/seller-hook-payer-rail.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PAYER_AMBIGUOUS_REASON,
  createTwzrdSettleGuard,
  defaultExtractPayer,
  type PayerScreen,
  type SettleGuardContext,
} from "../src/seller-hook.js";
import { EXACT_SVM_TRANSFER_CHECKED_FIXTURE as SVM } from "./fixtures/exact-svm-transfer-checked.js";

const WASH = SVM.expectedTokenPayer; // the authority in the signed transaction
const CLEAN = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const CLEAN_EVM = "0x00000000000000000000000000000000000000c1";
const WASH_EVM = "0x00000000000000000000000000000000000000d2";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE = "eip155:8453";

/** A screen that flags the two wash wallets and records what it was asked. */
function rig(options: { failOpen?: boolean } = {}) {
  const screened: string[] = [];
  const reasons: string[] = [];
  const guard = createTwzrdSettleGuard({
    screen: (payer): PayerScreen => {
      screened.push(payer);
      return { washFlagged: payer === WASH || payer === WASH_EVM };
    },
    onDecision: (d) => reasons.push(d.reason),
    ...options,
  });
  return { guard, screened, reasons };
}

const spoofs: Array<[string, Record<string, unknown>]> = [
  ["authorization.from", { authorization: { from: CLEAN } }],
  ["authorization.payer", { authorization: { payer: CLEAN } }],
  ["permit2Authorization.from", { permit2Authorization: { from: CLEAN } }],
  ["an EVM-looking authorization.from", { authorization: { from: CLEAN_EVM } }],
];

/** Where an x402 context can name the network. */
const solanaContexts: Array<[string, (payload: Record<string, unknown>) => SettleGuardContext]> = [
  ["requirements.network", (payload) => ({ paymentPayload: { payload }, requirements: { network: SOLANA_MAINNET } })],
  ["requirements.network (v1 name)", (payload) => ({ paymentPayload: { payload }, requirements: { network: "solana" } })],
  ["paymentPayload.accepted.network", (payload) => ({ paymentPayload: { payload, accepted: { network: SOLANA_MAINNET } } })],
  ["paymentPayload.network", (payload) => ({ paymentPayload: { payload, network: "solana" } })],
];

test("control: an honest exact-SVM payment from a flagged payer is refused", async () => {
  const { guard, screened } = rig();
  const result = await guard({ paymentPayload: { payload: { transaction: SVM.transactionBase64 } }, requirements: { network: SOLANA_MAINNET } });
  assert.deepEqual(result && result.reason, "twzrd_payer_wash_flagged");
  assert.deepEqual(screened, [WASH]);
});

test("on a Solana rail an unsigned EVM field does not replace the transaction's payer", async () => {
  for (const [where, ctxOf] of solanaContexts) {
    for (const [field, extra] of spoofs) {
      const label = `${field} with the network in ${where}`;
      const ctx = ctxOf({ ...extra, transaction: SVM.transactionBase64 });
      assert.equal(await defaultExtractPayer(ctx), WASH, label);
      for (const failOpen of [undefined, false]) {
        const { guard, screened } = rig({ failOpen });
        const result = await guard(ctx);
        assert.equal(result && result.reason, "twzrd_payer_wash_flagged", label);
        assert.deepEqual(screened, [WASH], `${label}: only the signing authority is screened`);
      }
    }
  }
});

test("on an EVM rail a transaction field does not replace the signed authorization", async () => {
  const ctx: SettleGuardContext = {
    paymentPayload: { payload: { authorization: { from: WASH_EVM }, transaction: SVM.transactionBase64 } },
    requirements: { network: BASE },
  };
  assert.equal(await defaultExtractPayer(ctx), WASH_EVM);
  const { guard, screened } = rig();
  const result = await guard(ctx);
  assert.equal(result && result.reason, "twzrd_payer_wash_flagged");
  assert.deepEqual(screened, [WASH_EVM]);
});

test("a body for the other rail is not a payer", async () => {
  // Solana rail, only an EVM body: nothing here settles, so nothing is screened as the payer.
  const evmOnSolana: SettleGuardContext = { paymentPayload: { payload: { authorization: { from: CLEAN } } }, requirements: { network: SOLANA_MAINNET } };
  assert.equal(await defaultExtractPayer(evmOnSolana), null);
  // EVM rail, only a transaction body.
  const svmOnEvm: SettleGuardContext = { paymentPayload: { payload: { transaction: SVM.transactionBase64 } }, requirements: { network: BASE } };
  assert.equal(await defaultExtractPayer(svmOnEvm), null);
  const closed = rig({ failOpen: false });
  assert.equal((await closed.guard(evmOnSolana))?.reason, "twzrd_payer_unresolved");
  assert.deepEqual(closed.screened, []);
});

test("both bodies and no network: refused, whatever failOpen says", async () => {
  for (const [field, extra] of spoofs) {
    const ctx: SettleGuardContext = { paymentPayload: { payload: { ...extra, transaction: SVM.transactionBase64 } }, requirements: {} };
    assert.equal(await defaultExtractPayer(ctx), null, field);
    for (const failOpen of [undefined, true, false]) {
      const { guard, screened, reasons } = rig({ failOpen });
      const result = await guard(ctx);
      assert.equal(result && result.reason, PAYER_AMBIGUOUS_REASON, `${field} failOpen=${failOpen}`);
      assert.deepEqual(screened, [], "no wallet is screened in place of the payer");
      assert.deepEqual(reasons, [PAYER_AMBIGUOUS_REASON]);
    }
  }
  // An unrecognised network name is not a rail either.
  const other: SettleGuardContext = {
    paymentPayload: { payload: { authorization: { from: CLEAN }, transaction: SVM.transactionBase64 } },
    requirements: { network: "stellar:pubnet" },
  };
  assert.equal((await rig().guard(other))?.reason, PAYER_AMBIGUOUS_REASON);
});

test("a single body with no network is read as before", async () => {
  const noNetwork = (payload: Record<string, unknown>): SettleGuardContext => ({ paymentPayload: { payload }, requirements: {} });
  assert.equal(await defaultExtractPayer(noNetwork({ transaction: SVM.transactionBase64 })), WASH);
  assert.equal(await defaultExtractPayer(noNetwork({ authorization: { from: WASH_EVM } })), WASH_EVM);
  assert.equal(await defaultExtractPayer(noNetwork({ permit2Authorization: { from: WASH_EVM } })), WASH_EVM);
  assert.equal(await defaultExtractPayer(noNetwork({ payer: CLEAN })), CLEAN);
  // A caller's own extractor is not second-guessed.
  const own = createTwzrdSettleGuard({ screen: () => ({ washFlagged: false }), getPayer: () => CLEAN });
  assert.equal(
    await own(noNetwork({ authorization: { from: CLEAN }, transaction: SVM.transactionBase64 })),
    undefined,
  );
});
