/**
 * x402 SVM exact `extra.splits` (0.18.0): a Solana exact requirement that names
 * extra recipients is refused with `svm_splits_refused` before intel and before
 * any signature. Empty or absent splits are allowed; EVM is not checked.
 * Run: npx tsx test/x402-svm-splits.test.ts
 */
import assert from "node:assert/strict";

import { evaluate_x402_resource } from "../src/evaluate.js";
import { createTwzrdPayingFetch, TwzrdWashAbortError } from "../src/paying-fetch.js";
import {
  hasSvmExactSplits,
  resolveRequirementFields,
  SVM_SPLITS_REFUSED,
} from "../src/payto.js";
import {
  installTwzrdX402ClientHook,
  mapX402SolanaRequirements,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type X402ClientLike,
} from "../src/x402-client-hook.js";
import type { X402PaymentRequirements } from "../src/types.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE = "eip155:8453";
const SELLER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const OTHER = "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC";
const EVM_SELLER = "0x1111111111111111111111111111111111111111";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ORIGIN = "https://origin.example/paid";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function svm(extra?: Record<string, unknown>, network = SOL): Record<string, unknown> {
  return {
    scheme: "exact",
    network,
    payTo: SELLER,
    amount: "10000",
    asset: USDC_SOL,
    ...(extra === undefined ? {} : { extra: { feePayer: OTHER, ...extra } }),
  };
}

const REFUSED: Array<[string, Record<string, unknown>]> = [
  ["non-empty splits", svm({ splits: [{ recipient: OTHER, amount: "9000" }] })],
  ["object splits", svm({ splits: { recipient: OTHER, amount: "9000" } })],
  ["string splits", svm({ splits: OTHER })],
  ["null splits", svm({ splits: null })],
  ["legacy solana network", svm({ splits: [{ recipient: OTHER, amount: "1" }] }, "solana")],
  ["legacy solana-devnet network", svm({ splits: [{ recipient: OTHER, amount: "1" }] }, "solana-devnet")],
  ["bare mainnet-beta network", svm({ splits: [{ recipient: OTHER, amount: "1" }] }, "mainnet-beta")],
  ["bare devnet network", svm({ splits: [{ recipient: OTHER, amount: "1" }] }, "devnet")],
  ["bare testnet network", svm({ splits: [{ recipient: OTHER, amount: "1" }] }, "testnet")],
  ["bare mainnet genesis id", svm({ splits: [{ recipient: OTHER, amount: "1" }] }, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")],
  ["bare devnet genesis id", svm({ splits: [{ recipient: OTHER, amount: "1" }] }, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")],
  ["bare testnet genesis id", svm({ splits: [{ recipient: OTHER, amount: "1" }] }, "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY")],
  ["missing network with base58 payTo", { ...svm({ splits: [{ recipient: OTHER, amount: "1" }] }), network: undefined }],
  ["scheme absent", { ...svm({ splits: [{ recipient: OTHER, amount: "1" }] }), scheme: undefined }],
];
const ALLOWED: Array<[string, Record<string, unknown>]> = [
  ["empty splits", svm({ splits: [] })],
  ["splits key absent", svm({})],
  ["extra absent", svm()],
  [
    "EVM exact with extra.splits",
    {
      scheme: "exact",
      network: BASE,
      payTo: EVM_SELLER,
      amount: "10000",
      asset: USDC_BASE,
      extra: { name: "USD Coin", version: "2", splits: [{ recipient: OTHER, amount: "9000" }] },
    },
  ],
  [
    "missing network with EVM payTo stays out of scope",
    {
      scheme: "exact",
      network: undefined,
      payTo: EVM_SELLER,
      amount: "10000",
      asset: USDC_BASE,
      extra: { splits: [{ recipient: OTHER, amount: "9000" }] },
    },
  ],
  [
    "unknown network with extra.splits stays out of scope",
    {
      scheme: "exact",
      network: "eip155:1",
      payTo: EVM_SELLER,
      amount: "10000",
      asset: USDC_BASE,
      extra: { splits: [{ recipient: OTHER, amount: "9000" }] },
    },
  ],
];

/** Intel that allows everything; counts calls so a refusal can prove intel was never asked. */
function allowIntel() {
  let calls = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    calls += 1;
    const u = String(input);
    if (u.includes("merchant_card")) return json({ wash_flagged: false, wash_confidence: "full" });
    return json({
      readiness_card: { decision: "allow", trust_score: 95, can_spend: true, seller_wallet: SELLER },
      wash_flagged: false,
      wash_confidence: "full",
    });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function mockClient() {
  let hook: ((ctx: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>) | undefined;
  const client: X402ClientLike = {
    onBeforePaymentCreation(h) {
      hook = h;
      return client;
    },
  };
  return {
    client,
    fire: (ctx: BeforePaymentCreationContext) => {
      if (!hook) throw new Error("hook not installed");
      return hook(ctx);
    },
  };
}

async function run() {
  // 1. The choke point: resolveRequirementFields / hasSvmExactSplits.
  for (const [label, req] of REFUSED) {
    assert.equal(hasSvmExactSplits(req), true, label);
    assert.equal(resolveRequirementFields(req).conflict, SVM_SPLITS_REFUSED, label);
  }
  for (const [label, req] of ALLOWED) {
    assert.equal(hasSvmExactSplits(req), false, label);
    assert.equal(resolveRequirementFields(req).conflict, undefined, label);
  }
  assert.equal(SVM_SPLITS_REFUSED, "svm_splits_refused");
  // A non-exact SVM scheme is out of scope for this check.
  assert.equal(hasSvmExactSplits({ ...svm({ splits: [{ recipient: OTHER }] }), scheme: "upto" }), false);

  // The mapped copy must still refuse. Dropping extra made the copy look clean.
  const withSplits = svm({ splits: [{ recipient: OTHER, amount: "1" }] });
  const mapped = mapX402SolanaRequirements(withSplits as never) as Record<string, unknown>;
  assert.equal(hasSvmExactSplits(mapped), true, "clean map keeps extra.splits");
  const conflicted = { ...withSplits, amount: "1000", maxAmountRequired: "2" };
  const mappedConflict = mapX402SolanaRequirements(conflicted as never) as Record<string, unknown>;
  assert.equal(hasSvmExactSplits(mappedConflict), true, "conflict map keeps extra.splits");
  // The detector fold: a bare cluster name on the mapped copy still refuses.
  const bareMapped = mapX402SolanaRequirements(
    svm({ splits: [{ recipient: OTHER, amount: "1" }] }, "mainnet-beta") as never,
  ) as Record<string, unknown>;
  assert.equal(hasSvmExactSplits(bareMapped), true, "bare-name map keeps extra.splits");

  // 2. Official x402Client hook: refused splits abort before payload creation,
  //    with no intel call. The hook's abort is what stops createPaymentPayload.
  for (const [label, req] of REFUSED) {
    const intel = allowIntel();
    const { client, fire } = mockClient();
    installTwzrdX402ClientHook(client, { fetch: intel.fetchImpl, refuseWashFlagged: false });
    const out = await fire({ selectedRequirements: req as never } as BeforePaymentCreationContext);
    assert.equal(out?.abort, true, `${label}: client hook aborts`);
    assert.match(String(out?.reason), /svm_splits_refused/, label);
    assert.equal(intel.calls(), 0, `${label}: refused before intel`);
  }
  for (const [label, req] of ALLOWED) {
    const intel = allowIntel();
    const { client, fire } = mockClient();
    installTwzrdX402ClientHook(client, { fetch: intel.fetchImpl, refuseWashFlagged: false });
    const out = await fire({ selectedRequirements: req as never } as BeforePaymentCreationContext);
    assert.doesNotMatch(String(out?.reason ?? ""), /svm_splits_refused/, `${label}: not refused by the splits check`);
  }

  // 3. evaluate_x402_resource (withTwzrdGuard, gate): refused before intel.
  for (const [label, req] of REFUSED) {
    const intel = allowIntel();
    const r = await evaluate_x402_resource(ORIGIN, req as X402PaymentRequirements, { fetch: intel.fetchImpl });
    assert.equal(r.approved, false, label);
    assert.equal(r.reason, SVM_SPLITS_REFUSED, label);
    assert.equal(intel.calls(), 0, `${label}: evaluate refused before intel`);
  }
  for (const [label, req] of ALLOWED) {
    const intel = allowIntel();
    const r = await evaluate_x402_resource(ORIGIN, req as X402PaymentRequirements, { fetch: intel.fetchImpl });
    assert.notEqual(r.reason, SVM_SPLITS_REFUSED, label);
  }

  // 4. createTwzrdPayingFetch: the payment step (wrapPay's paid leg) never runs.
  for (const [label, req] of REFUSED) {
    let paid = 0;
    const raw = (async () => json({ x402Version: 2, accepts: [req] }, 402)) as typeof fetch;
    const wrapPay = (g: typeof fetch): typeof fetch => async (input, init) => {
      const r = await g(input, init);
      if (r.status !== 402) return r;
      paid += 1;
      return new Response("paid", { status: 200 });
    };
    const pf = createTwzrdPayingFetch({ fetch: allowIntel().fetchImpl, rawFetch: raw, wrapPay });
    await assert.rejects(
      () => pf(ORIGIN),
      (err: unknown) => err instanceof TwzrdWashAbortError && /svm_splits_refused/.test(err.message),
      label,
    );
    assert.equal(paid, 0, `${label}: payment never invoked`);
  }
  for (const [label, req] of ALLOWED.slice(0, 3)) {
    let paid = 0;
    const raw = (async () => json({ x402Version: 2, accepts: [req] }, 402)) as typeof fetch;
    const wrapPay = (g: typeof fetch): typeof fetch => async (input, init) => {
      const r = await g(input, init);
      if (r.status !== 402) return r;
      paid += 1;
      return new Response("paid", { status: 200 });
    };
    const pf = createTwzrdPayingFetch({ fetch: allowIntel().fetchImpl, rawFetch: raw, wrapPay });
    assert.equal((await pf(ORIGIN)).status, 200, label);
    assert.equal(paid, 1, `${label}: payment proceeds`);
  }

  console.log("x402-svm-splits: ok");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
