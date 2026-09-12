/**
 * RED TEAM — attack class 2 (mismatched payTo) + 3 (redirects) + the
 * resource-bind leaf.
 *
 * Claim under attack: "an ALLOWED payment can only be signed exactly as
 * approved." That requires the approved requirement to be the ONLY requirement
 * the signer can act on. These tests show where it is not.
 *
 * `DEFECT:` assertions encode CURRENT behavior. Run:
 *   npx tsx test/red-payto-binding.test.ts
 */
import assert from "node:assert/strict";
import { twzrd } from "../src/spend-control.js";
import { withTwzrdGuard } from "../src/with-guard.js";
import {
  rememberRawInvoice,
  resourceBindLeafHash,
  stampResourceBind,
} from "../src/resource-bind.js";

const GOOD = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const EVIL_SOL = "EViL1neGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const EVIL_EVM = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RES = "https://merchant.example/paid";

const resp402 = (b: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(b), { status: 402, headers: { "content-type": "application/json" } })) as typeof fetch;

/** Captures the preflight request body the gate sent to intel. */
function recordingPreflight(card: Record<string, unknown>) {
  const seen: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = (async (_u: unknown, init: { body?: unknown } = {}) => {
    if (init.body) seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ readiness_card: card }), { status: 200 });
  }) as typeof fetch;
  return { seen, fetch: fetchImpl };
}

async function run() {
  /* ---------- 2a. DEFECT #13 (CRITICAL): the guard approves ONE accepts[] entry
   * but hands the payer the WHOLE unfiltered 402. --------------------------- */
  // withTwzrdGuard evaluates pickRequirements(accepts) — which deliberately
  // PREFERS the Solana entry — then returns the original 402 response untouched
  // for "the caller to pay". Any x402 payer that makes its own selection (most
  // take accepts[0], or prefer their own chain) signs a requirement TWZRD never
  // evaluated. Nothing binds the approval to the entry that gets signed.
  // SHOULD BE: the guard returns a 402 whose accepts[] is exactly [approved],
  // or aborts when the payer's selection differs from the approved one.
  {
    const dual = {
      x402Version: 1,
      accepts: [
        // attacker-controlled, listed first, 900x the price, unscored network
        { scheme: "exact", network: "eip155:8453", payTo: EVIL_EVM, maxAmountRequired: "9000000", asset: "0xusdc", resource: RES },
        // the benign entry TWZRD prefers and preflights
        { scheme: "exact", network: "solana", payTo: GOOD, maxAmountRequired: "10000", asset: USDC, resource: RES },
      ],
    };
    const pf = recordingPreflight({ decision: "allow", trust_score: 90, can_spend: true });
    const guarded = withTwzrdGuard(resp402(dual), { fetch: pf.fetch, refuseWashFlagged: false });

    // A payer that selects accepts[0] — the x402 default ordering contract.
    let signed: Record<string, unknown> | undefined;
    const payer = async (input: string) => {
      const r = await guarded(input);
      if (r.status !== 402) return r;
      const b = (await r.clone().json()) as { accepts: Array<Record<string, unknown>> };
      signed = b.accepts[0];
      return new Response("paid", { status: 200 });
    };
    const out = await payer(RES);
    assert.equal(out.status, 200, "the guard let the payment proceed");

    assert.equal(pf.seen.length, 1, "exactly one preflight ran");
    assert.equal(pf.seen[0].seller_wallet, GOOD, "TWZRD evaluated the Solana entry");
    assert.equal(pf.seen[0].price_usdc, 0.01, "TWZRD priced the payment at $0.01");

    assert.equal(signed?.payTo, EVIL_EVM,
      "DEFECT: the signer signed a payTo the gate never evaluated");
    assert.equal(signed?.maxAmountRequired, "9000000",
      "DEFECT: 9.00 USDC signed after a $0.01 approval");
    assert.notEqual(signed?.payTo, pf.seen[0].seller_wallet,
      "DEFECT: approved recipient !== signed recipient");
  }

  /* ---------- 2b. DEFECT #14 (high): twzrd.safeFetch hands the signer the raw
   * body INCLUDING accepts[] entries its own allowNetworks filter refused. --- */
  // `pay({ url, paymentRequired, selected })` receives the untouched `body`, not
  // the `filtered` list. A payer that re-selects from `paymentRequired` walks
  // straight past network_not_allowed / over_max_spend.
  // SHOULD BE: paymentRequired.accepts === [selected].
  {
    const dual = {
      x402Version: 1,
      accepts: [
        { scheme: "exact", network: "eip155:8453", payTo: EVIL_EVM, maxAmountRequired: "9000000", asset: "0xusdc", resource: RES },
        { scheme: "exact", network: "solana", payTo: GOOD, amount: "10000", asset: USDC, resource: RES },
      ],
    };
    let handed: { selected: Record<string, unknown>; paymentRequired: unknown } | undefined;
    const r = await twzrd.safeFetch(RES, {
      fetch: resp402(dual),
      maxSpend: "1.00",
      allowNetworks: ["solana"],
      pay: async (a) => { handed = a; return { response: new Response("ok") }; },
    });
    assert.equal(r.verdict, "allow");
    assert.equal(handed?.selected.payTo, GOOD, "the gate selected the solana entry");

    const nets = ((handed?.paymentRequired as { accepts: Array<{ network: string }> }).accepts)
      .map((a) => a.network);
    assert.deepEqual(nets, ["eip155:8453", "solana"],
      "DEFECT: the refused eip155 entry is still in the material handed to the signer");
    // Proof the filter is advisory: a payer honouring `paymentRequired` pays the
    // very entry allowNetworks was configured to forbid.
    const bypass = (handed?.paymentRequired as { accepts: Array<Record<string, unknown>> }).accepts[0];
    assert.equal(bypass.payTo, EVIL_EVM, "DEFECT: allowNetworks is not enforced at the signer boundary");
  }

  /* ---------- 2c. same-network, differs-only-in-last-char payTo ---------- */
  // The gate does preflight the exact advertised string, so a near-miss wallet
  // is evaluated on its own merits rather than folded onto the trusted one.
  // Locked in as a PASS: this is the behavior the claim needs.
  {
    const near = GOOD.slice(0, -1) + (GOOD.endsWith("k") ? "j" : "k");
    assert.notEqual(near, GOOD);
    const pf = recordingPreflight({ decision: "block", trust_score: 3 });
    const guarded = withTwzrdGuard(
      resp402({ x402Version: 1, accepts: [{ scheme: "exact", network: "solana", payTo: near, maxAmountRequired: "10000", asset: USDC, resource: RES }] }),
      { fetch: pf.fetch, refuseWashFlagged: false },
    );
    await assert.rejects(() => guarded(RES), /payment blocked/, "near-miss wallet is evaluated, not aliased");
    assert.equal(pf.seen[0].seller_wallet, near, "the exact advertised wallet was the one scored");
  }

  /* ---------- 3. DEFECT #15 (medium): redirect — the 402 comes from another
   * origin, but the preflight is told the ORIGINAL url. ---------------------- */
  // fetch follows 3xx internally (redirect:"follow" is the default), so the
  // guard only ever sees the FINAL 402 while `requestUrl(input)` is still the
  // pre-redirect URL. When the final accepts[] entry omits `resource` (legal in
  // x402 v2, where resource lives on the envelope), the audit record binds an
  // attacker's wallet to a trusted resource URL.
  // SHOULD BE: preflight resource_url is the post-redirect response URL.
  {
    const finalBody = {
      x402Version: 1,
      accepts: [{ scheme: "exact", network: "solana", payTo: EVIL_SOL, maxAmountRequired: "10000", asset: USDC }],
    };
    const pf = recordingPreflight({ decision: "allow", trust_score: 90, can_spend: true });
    const guarded = withTwzrdGuard(resp402(finalBody), { fetch: pf.fetch, refuseWashFlagged: false });
    await guarded("https://trusted.example/article");

    assert.equal(pf.seen[0].seller_wallet, EVIL_SOL, "the seller is from the redirect target");
    assert.equal(pf.seen[0].resource_url, "https://trusted.example/article",
      "DEFECT: preflight attributes the payment to the pre-redirect origin");
    assert.equal(pf.seen[0].resource_name, "https://trusted.example/article",
      "DEFECT: the resource NAME in the audit record is the trusted origin too");
  }

  /* ---------- 3b. each 402 IS re-evaluated — no stale decision reuse (PASS) ---------- */
  // Structural: withTwzrdGuard holds no decision state between calls, so a
  // second 402 (redirect chain, retry, or new resource) always re-preflights.
  {
    const pf = recordingPreflight({ decision: "allow", trust_score: 90, can_spend: true });
    const guarded = withTwzrdGuard(
      resp402({ x402Version: 1, accepts: [{ scheme: "exact", network: "solana", payTo: GOOD, maxAmountRequired: "10000", asset: USDC, resource: RES }] }),
      { fetch: pf.fetch, refuseWashFlagged: false },
    );
    await guarded(RES);
    await guarded(RES);
    await guarded("https://merchant.example/other");
    assert.equal(pf.seen.length, 3, "every 402 is independently preflighted; no cached allow");
  }

  /* ---------- DEFECT #16 (high): resource-bind leaf is computed from a
   * process-global invoice cache that ANY earlier 402 can poison. ------------ */
  // `rawInvoiceByResource` is a module-level Map keyed by resource URL, filled
  // by rememberRawInvoice() from every 402 the process sees. stampResourceBind
  // prefers that cached body OVER the live `paymentRequired` it is handed, so a
  // stale/attacker invoice for the same URL decides the leaf hash — in a
  // multi-agent process the cache is shared across tenants.
  // SHOULD BE: the leaf is computed from the paymentRequired for THIS request.
  {
    const selected = { scheme: "exact", network: "solana", payTo: GOOD, amount: "10000", asset: USDC, resource: RES };
    const honest = { x402Version: 1, accepts: [{ ...selected }] };
    const cleanLeaf = resourceBindLeafHash(selected);
    assert.equal(stampResourceBind({ ...selected }, honest).leaf_hash, cleanLeaf, "baseline leaf");

    // An earlier, unrelated 402 claims the same resource URL with a different
    // resource string on the entry.
    rememberRawInvoice(
      { x402Version: 1, accepts: [{ ...selected, resource: "https://attacker.example/OTHER" }] },
      RES,
    );
    const poisoned = stampResourceBind({ ...selected }, honest);
    assert.notEqual(poisoned.leaf_hash, cleanLeaf,
      "DEFECT: a poisoned cache entry changes the bind leaf for an honest 402");
    assert.equal(poisoned.strength, "soft", "and it is still reported as a successful stamp");
  }

  console.log("red-payto-binding.test.ts: ALL PASSED (4 DEFECTS encoded — see DEFECT: comments)");
}

run().catch((e) => {
  console.error("red-payto-binding.test.ts FAILED:", e);
  process.exit(1);
});
