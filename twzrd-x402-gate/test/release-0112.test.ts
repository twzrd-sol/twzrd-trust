/**
 * 0.11.2 release: regressions for the 0.11.1 audit findings.
 * Every refusal here must happen before the wallet is asked to sign.
 * Run: npx tsx test/release-0112.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { evaluate_x402_resource } from "../src/evaluate.js";
import { twzrdOnPaymentRequested } from "../src/mcp-hook.js";
import { classifyNetwork } from "../src/network.js";
import {
  isUsdcRequirement,
  pickRequirements,
  priceUsdcFromAmountMicro,
  resolveRequirementFields,
} from "../src/payto.js";
import { twzrdApprovePayment } from "../src/policy.js";
import { twzrd } from "../src/spend-control.js";
import { withTwzrdGuard } from "../src/with-guard.js";
import { wrapFetchWithTwzrdGate } from "../src/wrap-fetch.js";
import {
  createTwzrdBeforePaymentHook,
  evaluateBeforePaymentCreation,
} from "../src/x402-client-hook.js";
import {
  TwzrdBasePaymentBlockedError,
  withTwzrdBasePreflight,
} from "../src/cloudflare-base.js";

const SOL_SELLER = "SeLLeRWa11et1111111111111111111111111111111";
const SOL_CLEAN = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const BASE_WASH = "0x1111111111111111111111111111111111111111";
const BASE_SELLER = "0x3803A19280DeeFe533D177C4A169412BD341101b";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OTHER_ERC20 = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const allowCard = { decision: "allow", trust_score: 90, score: 90, can_spend: true, recommended_cap_usdc: 1 };
const unknownCard = (cap = 0.1) => ({
  decision: "warn", trust_score: 45, score: null, null_reason: "unknown_subject", can_spend: true, recommended_cap_usdc: cap,
});

/** Intel stub: per-wallet cards; records every call. */
function intel(cards: Record<string, Record<string, unknown>>, fallback: Record<string, unknown> = allowCard, wash: Record<string, boolean> = {}) {
  const calls: string[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const m = u.match(/merchant_card\/([^?]+)/);
    if (m) return json({ wash_flagged: wash[decodeURIComponent(m[1])] ?? false });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const card = cards[body.seller_wallet] ?? fallback;
    return json({ readiness_card: card });
  }) as unknown as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const preflights = (calls: string[]) => calls.filter((u) => u.includes("/preflight")).length;

async function run() {
  // ---------------------------------------------------------------- D3-1
  // A present amount that is not an ASCII base-unit integer is refused on every
  // seat before intel. A negative amount used to clear every cap.
  {
    for (const bad of ["-50000000", "-1", "0.5", "1e6", " 100", "100 ", "", "abc", "Infinity", "0x10", "١٠٠", "+100"]) {
      const f = resolveRequirementFields({ payTo: SOL_SELLER, amount: bad });
      assert.equal(f.conflict, "amount_malformed", `resolveRequirementFields(${JSON.stringify(bad)})`);
      assert.equal(priceUsdcFromAmountMicro(bad), undefined, `price(${JSON.stringify(bad)})`);
    }
    for (const good of ["0", "1", "100000", "00100"]) {
      assert.equal(resolveRequirementFields({ payTo: SOL_SELLER, amount: good }).conflict, undefined, good);
    }
    // The x402-solana seat, called exactly as createX402Client({ beforePayment }) calls it.
    for (const card of [unknownCard(), allowCard]) {
      const f = intel({}, card);
      const hook = createTwzrdBeforePaymentHook({ fetch: f });
      const r = await hook({ payTo: SOL_SELLER, network: MAINNET, amount: "-50000000", asset: USDC_SOL, scheme: "exact" });
      assert.ok(r && r.abort === true, "x402-solana seat must abort a negative amount");
      assert.match(String(r.reason), /amount_malformed/);
      assert.equal(f.calls.length, 0, "refused before intel");
    }
    // Other seats.
    {
      const f = intel({});
      const r = await evaluate_x402_resource("https://s/x", { payTo: SOL_SELLER, network: MAINNET, amount: "abc", asset: USDC_SOL }, { fetch: f });
      assert.equal(r.approved, false);
      assert.match(r.reason, /amount_malformed/);
      assert.equal(f.calls.length, 0);
    }
    {
      const f = intel({});
      const ok = await twzrdOnPaymentRequested(
        { paymentRequired: { accepts: [{ payTo: SOL_SELLER, network: MAINNET, amount: "-5", asset: USDC_SOL }] } } as never,
        resolveConfig({ fetch: f }),
      );
      assert.equal(ok, false);
      assert.equal(f.calls.length, 0);
    }
    // Direct policy callers with a computed price.
    for (const p of [-50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = intel({});
      const r = await twzrdApprovePayment({ payTo: SOL_SELLER, chain: MAINNET, priceUsdc: p }, resolveConfig({ fetch: f }));
      assert.equal(r.approved, false, `priceUsdc ${p}`);
      assert.equal(r.reason, "twzrd_invalid_price");
      assert.equal(f.calls.length, 0);
    }
  }

  // ---------------------------------------------------------------- D3-2
  // A fetch wrapper cannot know which accepts[] entry the payer will pick, so
  // every distinct entry must pass. Seller lists [Base -> wash, Solana -> clean].
  {
    const accepts = [
      { scheme: "exact", network: "eip155:8453", payTo: BASE_WASH, amount: "1000", asset: USDC_BASE },
      { scheme: "exact", network: MAINNET, payTo: SOL_CLEAN, amount: "1000", asset: USDC_SOL },
    ];
    const body402 = () => json({ x402Version: 2, accepts, resource: { url: "https://s/x" } }, 402);
    const blockWash = { [BASE_WASH]: { decision: "block", trust_score: 5, score: 5 } };

    {
      const f = intel(blockWash);
      const guarded = withTwzrdGuard((async () => body402()) as typeof fetch, { fetch: f });
      await assert.rejects(() => guarded("https://s/x"), /twzrd_decision_block/);
    }
    {
      const f = intel(blockWash);
      const wrapped = wrapFetchWithTwzrdGate((async () => body402()) as typeof fetch, resolveConfig({ fetch: f }));
      await assert.rejects(() => wrapped("https://s/x"), /twzrd_decision_block/);
    }
    {
      const f = intel(blockWash);
      const ok = await twzrdOnPaymentRequested({ paymentRequired: { accepts } } as never, resolveConfig({ fetch: f }));
      assert.equal(ok, false, "MCP: any refused offer refuses the payment");
    }
    // Controls: both entries clean -> passes; paid hops run at most once.
    {
      const f = intel({});
      const paid: string[] = [];
      const x402Fetch = (async (u: string | URL) => {
        paid.push(String(u));
        return json({ pubkey: SOL_CLEAN, score: 80 });
      }) as unknown as typeof fetch;
      const guarded = withTwzrdGuard((async () => body402()) as typeof fetch, {
        fetch: intel({}, { decision: "warn", trust_score: 60, score: 60, can_spend: true, recommended_cap_usdc: 1 }),
        x402Fetch,
      });
      const resp = await guarded("https://s/x");
      assert.equal(resp.status, 402);
      assert.ok(paid.length <= 1, `paid hops ran ${paid.length} times`);
      void f;
    }
    // Too many distinct offers is refused rather than fanned out.
    {
      const many = Array.from({ length: 9 }, (_, i) => ({ network: MAINNET, payTo: SOL_CLEAN, amount: String(1000 + i), asset: USDC_SOL }));
      const f = intel({});
      const wrapped = wrapFetchWithTwzrdGate((async () => json({ x402Version: 2, accepts: many }, 402)) as typeof fetch, resolveConfig({ fetch: f }));
      await assert.rejects(() => wrapped("https://s/x"), /too_many_payment_options/);
      assert.equal(f.calls.length, 0);
    }
  }

  // ---------------------------------------------------------------- D4-1
  // ./cloudflare-base signs only within the same rules as the package.
  {
    const req = (amount: string, asset?: string) => ({
      resource: "https://w/x",
      accepts: [{ network: "eip155:8453", payTo: BASE_SELLER, amount, ...(asset ? { asset } : {}) }],
    });
    const cfFetch = (card: Record<string, unknown>) =>
      (async () => json({ readiness_card: card })) as unknown as typeof fetch;
    let signed = 0;
    const sign = async () => { signed += 1; return "ok"; };
    const blocked = async (r: ReturnType<typeof req>, card: Record<string, unknown>, re: RegExp) => {
      const before = signed;
      await assert.rejects(
        () => withTwzrdBasePreflight(r, { fetch: cfFetch(card) }, sign),
        (e: unknown) => e instanceof TwzrdBasePaymentBlockedError && re.test((e as Error).message),
      );
      assert.equal(signed, before, `signed on ${re}`);
    };
    await blocked(req("1000", OTHER_ERC20), allowCard, /twzrd_non_usdc_asset/);
    await blocked(req("-1000"), allowCard, /amount_malformed/);
    await blocked(req("500000"), unknownCard(0.1), /twzrd_unevaluated_over_cap/);
    await blocked(req("1000"), { ...unknownCard(0.1), recommended_cap_usdc: undefined }, /twzrd_unevaluated_no_cap/);
    await blocked(req("2000000"), { ...allowCard, recommended_cap_usdc: 1 }, /twzrd_over_recommended_cap/);
    await blocked(req("1000"), { ...allowCard, wash_flagged: true }, /twzrd_wash_flagged/);
    await blocked(req("1000"), { decision: "warn", trust_score: 20, score: 20, recommended_cap_usdc: 1 }, /twzrd_score_20_below_40/);
    const out = await withTwzrdBasePreflight(req("50000", USDC_BASE), { fetch: cfFetch(unknownCard(0.1)) }, sign);
    assert.equal(out, "ok");
    assert.equal(signed, 1, "within-cap USDC signs once");
  }

  // ---------------------------------------------------------------- D2-02
  // onWarnUpsell can never crash the host or change the decision.
  {
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on("unhandledRejection", onUnhandled);
    const warn = { decision: "warn", trust_score: 60, score: 60, can_spend: true, recommended_cap_usdc: 1 };
    const rej = await twzrdApprovePayment(
      { payTo: SOL_SELLER, chain: MAINNET, priceUsdc: 0.01 },
      resolveConfig({ fetch: intel({}, warn), onWarnUpsell: () => Promise.reject(new Error("boom")) }),
    );
    const thr = await twzrdApprovePayment(
      { payTo: SOL_SELLER, chain: MAINNET, priceUsdc: 0.01 },
      resolveConfig({ fetch: intel({}, warn), failOpen: true, onWarnUpsell: () => { throw new Error("sync boom"); } }),
    );
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", onUnhandled);
    assert.equal(unhandled, 0, "a rejecting onWarnUpsell leaked an unhandled rejection");
    assert.equal(rej.reason, "twzrd_warn_allowed");
    assert.equal(thr.reason, "twzrd_warn_allowed", "a throwing onWarnUpsell must not become twzrd_fail_open");
  }

  // ---------------------------------------------------------------- D4-3 / D4-4 / D4-5
  // One Solana cluster reading for both classification and the USDC table.
  {
    for (const network of [undefined, "", "mainnet-beta", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "solana:mainnet", "solana", MAINNET]) {
      const f = intel({});
      const r = await twzrdApprovePayment(
        { payTo: SOL_SELLER, chain: network, priceUsdc: 0.001, asset: USDC_SOL },
        resolveConfig({ fetch: f }),
      );
      assert.notEqual(r.reason, "twzrd_non_usdc_asset", `genuine USDC refused on network ${JSON.stringify(network)}`);
      assert.ok(preflights(f.calls) === 1, `intel consulted for ${JSON.stringify(network)}`);
    }
    // Deliberately unchanged: the devnet CAIP-2 id stays scored (harnesses rely
    // on it reaching the preflight); only the USDC table reads the cluster.
    assert.equal(classifyNetwork(DEVNET).reputationScored, true);
    assert.equal(isUsdcRequirement({ network: DEVNET, asset: USDC_DEVNET }), true);
    assert.equal(isUsdcRequirement({ network: DEVNET, asset: USDC_SOL }), false);
    assert.equal(isUsdcRequirement({ network: "solana:devnet", asset: USDC_DEVNET }), true);
    assert.equal(isUsdcRequirement({ network: "solana:devnet", asset: USDC_SOL }), false);
    assert.equal(isUsdcRequirement({ network: MAINNET, asset: USDC_SOL.toLowerCase() }), false, "Solana mints compare exactly");
    assert.equal(isUsdcRequirement({ network: "eip155:8453", asset: USDC_BASE.toLowerCase() }), true, "EVM compares case-insensitively");
  }

  // ---------------------------------------------------------------- D2-01
  // A hung intel call becomes the documented fail-closed reason within the deadline.
  {
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await twzrdApprovePayment({ payTo: SOL_SELLER, chain: MAINNET, priceUsdc: 0.001 }, resolveConfig({ fetch: hang, intelTimeoutMs: 50 }));
    assert.equal(r.approved, false);
    assert.match(r.reason, /^twzrd_fail_closed/);
    assert.ok(Date.now() - t0 < 2000, "deadline honoured");
    const cardHang = (async (u: string | URL) =>
      /merchant_card/.test(String(u)) ? new Promise<Response>(() => {}) : json({ readiness_card: allowCard })) as unknown as typeof fetch;
    const r2 = await twzrdApprovePayment({ payTo: SOL_SELLER, chain: MAINNET, priceUsdc: 0.001 }, resolveConfig({ fetch: cardHang, intelTimeoutMs: 50 }));
    assert.match(r2.reason, /^twzrd_card_unreachable_fail_closed/);
    assert.equal(resolveConfig({}).intelTimeoutMs, 2000);
  }

  // ---------------------------------------------------------------- D2-03
  // A card outage allowed under failOpen is marked, not silent.
  {
    const down = (async (u: string | URL) =>
      /merchant_card/.test(String(u)) ? json({}, 503) : json({ readiness_card: allowCard })) as unknown as typeof fetch;
    const r = await twzrdApprovePayment({ payTo: SOL_SELLER, chain: MAINNET, priceUsdc: 0.001 }, resolveConfig({ fetch: down, failOpen: true }));
    assert.equal(r.approved, true);
    assert.equal(r.cardUnreachable, true);
  }

  // ---------------------------------------------------------------- D5-F1
  // No paid receipt for a seller intel has never evaluated.
  {
    const paid: string[] = [];
    const x402Fetch = (async (u: string | URL) => { paid.push(String(u)); return json({}); }) as unknown as typeof fetch;
    const r = await evaluateBeforePaymentCreation(
      { payTo: SOL_SELLER, network: MAINNET, amount: "50000", asset: USDC_SOL, resource: "https://s/x" },
      { fetch: intel({}, unknownCard(0.1)), x402Fetch, requireReceipt: { minSpendUsdc: 0 } },
    );
    assert.ok(!r || r.abort !== true, `within-cap unevaluated refused: ${JSON.stringify(r)}`);
    assert.equal(paid.length, 0, "no paid hop for an unevaluated seller");
  }

  // ---------------------------------------------------------------- D5-F3
  // Strict knobs read any truthy spelling as on.
  {
    for (const v of [true, "true", "TRUE", "1", 1, "yes", "on"] as unknown[]) {
      assert.equal(resolveConfig({ refuseUnevaluated: v as boolean }).refuseUnevaluated, true, `refuseUnevaluated ${String(v)}`);
      assert.equal(resolveConfig({ gateOnCanSpend: v as boolean }).gateOnCanSpend, true, `gateOnCanSpend ${String(v)}`);
    }
    for (const v of [false, "false", "0", 0, "", "no"] as unknown[]) {
      assert.equal(resolveConfig({ refuseUnevaluated: v as boolean }).refuseUnevaluated, false, `refuseUnevaluated ${String(v)}`);
    }
    for (const v of ["TRUE", "Yes", "on", "1"]) {
      process.env.TWZRD_REFUSE_UNEVALUATED = v;
      process.env.TWZRD_GATE_ON_CAN_SPEND = v;
      try {
        assert.equal(resolveConfig({}).refuseUnevaluated, true, `env ${v}`);
        assert.equal(resolveConfig({}).gateOnCanSpend, true, `env ${v}`);
      } finally {
        delete process.env.TWZRD_REFUSE_UNEVALUATED;
        delete process.env.TWZRD_GATE_ON_CAN_SPEND;
      }
    }
  }

  // ---------------------------------------------------------------- D3-3
  // Junk accepts refuse; they never throw a TypeError.
  {
    for (const junk of [{}, "abc", 42, [null, { network: MAINNET, payTo: SOL_SELLER }]] as unknown[]) {
      assert.doesNotThrow(() => pickRequirements(junk as never), `pickRequirements(${JSON.stringify(junk)})`);
    }
    assert.equal(pickRequirements([null, { network: MAINNET, payTo: SOL_SELLER }] as never).payTo, SOL_SELLER);
    const r = await twzrd.safeFetch("https://s/x", {
      fetch: (async () => json({ x402Version: 1, accepts: {} }, 402)) as unknown as typeof fetch,
      pay: async () => ({ response: new Response("ok") }),
    });
    assert.equal(r.verdict, "block");
    const ok = await twzrdOnPaymentRequested({ paymentRequired: { accepts: "abc" } } as never, resolveConfig({ fetch: intel({}) }));
    assert.equal(ok, false);
  }

  // ---------------------------------------------------------------- D3-4
  // The same EVM address in two cases is one recipient, not a conflict.
  {
    const f = resolveRequirementFields({ payTo: BASE_SELLER, pay_to: BASE_SELLER.toLowerCase(), amount: "1000" });
    assert.equal(f.conflict, undefined);
    const g = resolveRequirementFields({ payTo: SOL_SELLER, pay_to: SOL_SELLER.toLowerCase(), amount: "1000" });
    assert.equal(g.conflict, "payto_field_conflict", "base58 is case-sensitive");
  }

  console.log("release-0112.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("release-0112.test.ts FAILED:", e);
  process.exit(1);
});
