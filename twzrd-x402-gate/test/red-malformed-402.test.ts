/**
 * RED TEAM — attack class 1 (malformed 402s) + 6 (unsupported networks).
 *
 * Claim under attack: "the gate fails CLOSED on every malformed 402; a parse
 * failure never falls through to ALLOW."
 *
 * Assertions marked `DEFECT:` encode the CURRENT (vulnerable) behavior so the
 * suite stays green and the defect cannot silently rot. The comment above each
 * states what the assertion SHOULD be once fixed. A green run of this file does
 * NOT mean the gate is safe — read the DEFECT blocks.
 *
 * Run: npx tsx test/red-malformed-402.test.ts
 */
import assert from "node:assert/strict";
import { twzrd } from "../src/spend-control.js";
import { withTwzrdGuard } from "../src/with-guard.js";
import { classifyNetwork } from "../src/network.js";

const SOL = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RES = "https://merchant.example/paid";

const body = (over: Record<string, unknown> = {}) => ({
  x402Version: 1,
  accepts: [
    { scheme: "exact", network: "solana", payTo: SOL, amount: "10000", asset: USDC, resource: RES, ...over },
  ],
});
const f402 = (b: unknown): typeof fetch =>
  (async () =>
    new Response(typeof b === "string" ? b : JSON.stringify(b), {
      status: 402,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

/** Runs one malformed 402 through twzrd.safeFetch and reports what the signer saw. */
async function attempt(over: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  let signerCalls = 0;
  let signerSaw: Record<string, unknown> | undefined;
  const r = await twzrd.safeFetch(RES, {
    fetch: f402(body(over)),
    maxSpend: "1.00",
    pay: async (a) => {
      signerCalls += 1;
      signerSaw = a.selected;
      return { response: new Response("ok", { status: 200 }) };
    },
    ...opts,
  });
  return { verdict: r.verdict, reason: r.reason, reported: r.signerInvocations, signerCalls, signerSaw };
}

async function run() {
  /* ---------- 1a. shapes the gate DOES refuse (fail-closed, as claimed) ---------- */
  for (const [label, over] of [
    ["null payTo", { payTo: null }],
    ["missing payTo", { payTo: undefined }],
    ["null amount", { amount: null }],
    ["missing amount", { amount: undefined }],
  ] as Array<[string, Record<string, unknown>]>) {
    const r = await attempt(over);
    assert.equal(r.verdict, "block", `${label} must block`);
    assert.equal(r.reason, "no_payable_requirement", `${label} reason`);
    assert.equal(r.signerCalls, 0, `${label}: signer must be invoked ZERO times`);
  }

  // empty accepts[] and a missing accepts[] both yield no payable requirement
  for (const b of [{ x402Version: 1, accepts: [] }, { x402Version: 1 }]) {
    let signerCalls = 0;
    const r = await twzrd.safeFetch(RES, { fetch: f402(b), pay: async () => { signerCalls += 1; return {}; } });
    assert.equal(r.verdict, "block");
    assert.equal(signerCalls, 0, "empty/absent accepts must not reach the signer");
  }

  // an unparseable 402 body is refused by twzrd.safeFetch (this is the correct shape)
  {
    let signerCalls = 0;
    const r = await twzrd.safeFetch(RES, { fetch: f402("<html>not json</html>"), pay: async () => { signerCalls += 1; return {}; } });
    assert.equal(r.verdict, "block");
    assert.equal(r.reason, "unparseable_402");
    assert.equal(signerCalls, 0);
  }

  // DEFECT #0 (CRITICAL): the SAME condition fails OPEN in withTwzrdGuard — the
  // guard behind installTwzrdAutoGate's fetch adapter. with-guard.ts:74-77
  // catches the JSON parse error and `return resp`, handing the caller a 402 the
  // gate never evaluated. The x402 payer wrapped around it then pays it. This is
  // a parse failure falling through to ALLOW, and it contradicts both the
  // package's "fail-closed by default" description and twzrd.safeFetch above.
  // SHOULD BE: throw [twzrd-guard] payment blocked: unparseable_402.
  {
    const preflight: typeof fetch = (async () => {
      throw new Error("preflight must never be reached — the body never parsed");
    }) as typeof fetch;
    const bad: typeof fetch = (async () => new Response("<html>402 Payment Required</html>", { status: 402 })) as typeof fetch;

    const resp = await withTwzrdGuard(bad, { fetch: preflight, refuseWashFlagged: false })(RES);
    assert.equal(resp.status, 402,
      "DEFECT: withTwzrdGuard passes an ungated 402 straight through to the payer");
    assert.equal(await resp.text(), "<html>402 Payment Required</html>",
      "DEFECT: the caller receives the unparsed challenge and can pay it");

    // Contrast: a 402 that DOES parse but names no recipient fails closed, which
    // proves the pass-through above is an unintended asymmetry, not a policy.
    await assert.rejects(
      () => withTwzrdGuard(f402({ x402Version: 1, accepts: [] }), { fetch: preflight, refuseWashFlagged: false })(RES),
      /twzrd_unidentifiable_payment_recipient/,
      "an empty accepts[] fails closed",
    );
  }

  /* ---------- 1b. DEFECT: amounts that are not integers still reach the signer ---------- */

  // DEFECT #1 (critical): a NEGATIVE advertised amount is allowed and signed.
  // spend-control.ts:133 `BigInt(String(amountMicro).split(".")[0])` accepts "-…",
  // and every cap test is a `>` comparison, which a negative always passes.
  // SHOULD BE: assert.equal(neg.verdict, "block") / signerCalls === 0.
  {
    const neg = await attempt({ amount: "-5000000" });
    assert.equal(neg.verdict, "allow", "DEFECT: negative amount is ALLOWED");
    assert.equal(neg.signerCalls, 1, "DEFECT: signer invoked for a negative-amount 402");
    assert.equal(neg.signerSaw?.amount, "-5000000", "DEFECT: signer handed the negative amount verbatim");
  }

  // DEFECT #2 (high): an EMPTY-STRING amount is allowed and signed as 0 micro.
  // `amountMicro == null` is false for "", so the no_payable_requirement guard
  // misses it and `|| "0"` silently substitutes a zero spend.
  // SHOULD BE: block / signerCalls === 0.
  {
    const empty = await attempt({ amount: "" });
    assert.equal(empty.verdict, "allow", "DEFECT: empty-string amount is ALLOWED");
    assert.equal(empty.signerCalls, 1, "DEFECT: signer invoked with an unspecified amount");
    assert.equal(empty.signerSaw?.amount, "", "DEFECT: signer handed an empty amount");
  }

  // DEFECT #3 (medium): a non-numeric amount CRASHES instead of returning a block.
  // The BigInt() conversion throws a raw SyntaxError out of safeFetch, so the
  // documented `{verdict:"block"}` contract is not honoured. The signer is not
  // reached (so sign-blind survives), but a host `catch` that treats a gate
  // exception as "gate unavailable" would fail OPEN here.
  // SHOULD BE: resolves to { verdict:"block", reason:"unparseable_amount" }.
  for (const bad of ["abc", "1e6", "NaN", "Infinity", "1,000"]) {
    await assert.rejects(
      () => attempt({ amount: bad }),
      (e: unknown) => e instanceof SyntaxError && /BigInt/.test(String((e as Error).message)),
      `DEFECT: amount ${JSON.stringify(bad)} throws instead of blocking`,
    );
  }

  // DEFECT #4 (medium): a hex amount is silently reinterpreted. "0x10" is charged
  // as 16 micro-USDC against the cap; the signer is handed the string "0x10".
  {
    const hex = await attempt({ amount: "0x10" });
    assert.equal(hex.verdict, "allow", "DEFECT: hex amount accepted");
    assert.equal(hex.signerSaw?.amount, "0x10");
  }

  // DEFECT #5 (low): fractional base units are truncated toward zero, so "0.9"
  // is metered as 0 micro against every cap while the signer still gets "0.9".
  {
    const frac = await attempt({ amount: "0.9" }, { maxSpend: "0.000001" });
    assert.equal(frac.verdict, "allow", "DEFECT: fractional amount metered as 0");
    assert.equal(frac.signerSaw?.amount, "0.9");
  }

  // absurd-but-well-formed amounts DO fail closed
  {
    const huge = await attempt({ amount: "9".repeat(40) });
    assert.equal(huge.verdict, "block");
    assert.equal(huge.reason, "over_max_spend");
    assert.equal(huge.signerCalls, 0);
  }

  /* ---------- 1c. fields the gate never validates ---------- */

  // DEFECT #6 (medium): `scheme` is never checked. A 402 advertising an unknown
  // or absent settlement scheme is approved and handed to the signer unchanged.
  for (const scheme of [undefined, "", "exact-drain-v9", "permit2-sweep"]) {
    const r = await attempt({ scheme });
    assert.equal(r.verdict, "allow", `DEFECT: scheme ${JSON.stringify(scheme)} not validated`);
    assert.equal(r.signerCalls, 1);
  }

  // payTo is NOT normalized — leading/trailing whitespace and case are preserved
  // verbatim into the signer. This is the SAFE direction (no silent folding of a
  // homoglyph onto a trusted wallet) and is asserted here to lock it in.
  {
    const padded = ` ${SOL} `;
    const r = await attempt({ payTo: padded });
    assert.equal(r.signerSaw?.payTo, padded, "payTo must reach the signer byte-identical");
    const lower = await attempt({ payTo: SOL.toLowerCase() });
    assert.equal(lower.signerSaw?.payTo, SOL.toLowerCase(), "no case folding on payTo");
    assert.notEqual(SOL.toLowerCase(), SOL, "fixture sanity: case variant really differs");
  }

  /* ---------- 6. unsupported / garbage networks ---------- */

  // DEFECT #7 (high): classifyNetwork has NO code path that returns
  // networkSupported:false. The field is documented as "True when we recognize
  // the CAIP-2 / x402 network identifier shape", but it is a constant.
  for (const junk of ["%%NOT-A-CHAIN%%", "'; DROP TABLE--", "network", "1"]) {
    const c = classifyNetwork(junk, SOL);
    assert.equal(c.reputationScored, false, `${junk} must not be scored`);
    assert.equal(c.networkSupported, true, `DEFECT: junk network ${JSON.stringify(junk)} reported as supported`);
  }
  // decideUnsupportedNetwork's "network_missing" reason branch is unreachable:
  // classifyNetwork never emits that reason for any input, including undefined.
  assert.equal(classifyNetwork(undefined, SOL).reason, "solana_scored");
  assert.equal(classifyNetwork(null, "0x" + "a".repeat(40)).reason, "network_not_scored");

  // DEFECT #7b (high): a WHITESPACE-ONLY network string is trim()ed to "" and
  // then takes the "legacy integrator omitted network" branch — so the gate
  // claims a SCORED SOLANA reputation for a 402 that named a network it never
  // parsed. network.ts's own contract is "never invent a reputation".
  // SHOULD BE: reputationScored:false, reason:"network_not_scored".
  for (const blank of [" ", "\t", "\n", " "]) {
    const c = classifyNetwork(blank, SOL);
    assert.equal(c.reputationScored, true, `DEFECT: blank network ${JSON.stringify(blank)} scored as Solana`);
    assert.equal(c.reason, "solana_scored");
    assert.equal(c.network, undefined, "DEFECT: the advertised network string is discarded, not reported");
  }

  // DEFECT #8 (high): under the DEFAULT unsupportedNetworkMode ("observe") a
  // 402 on a network the gate cannot even parse is APPROVED before signing.
  // Fail-closed requires opting in to unsupportedNetworkMode:"strict".
  {
    const preflight: typeof fetch = (async () =>
      new Response(JSON.stringify({ readiness_card: { decision: "allow", trust_score: 90 } }), { status: 200 })) as typeof fetch;
    const merchant = f402(body({ network: "%%NOT-A-CHAIN%%" }));
    const guarded = withTwzrdGuard(merchant, { fetch: preflight, refuseWashFlagged: false });
    const resp = await guarded(RES);
    assert.equal(resp.status, 402, "DEFECT: garbage network passes the guard by default (observe)");

    const strict = withTwzrdGuard(merchant, {
      fetch: preflight, refuseWashFlagged: false, unsupportedNetworkMode: "strict",
    });
    await assert.rejects(() => strict(RES), /payment blocked: network_not_scored/, "strict mode does fail closed");
  }

  console.log("red-malformed-402.test.ts: ALL PASSED (9 DEFECTS encoded — see DEFECT: comments)");
}

run().catch((e) => {
  console.error("red-malformed-402.test.ts FAILED:", e);
  process.exit(1);
});
