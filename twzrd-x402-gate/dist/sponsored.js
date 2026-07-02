/**
 * Sponsored x402Fetch — the no-wallet friction-killer seam (PROTOTYPE).
 *
 * The gate's paid rungs (`quickCheck` $0.001, `autoReceipt` $0.05) need an
 * `x402Fetch` that settles USDC. Today the integrator must BYO that fetch (a
 * funded Solana wallet + an x402 client). This seam lets a SPONSOR settle on the
 * agent's behalf, so an integrator can use the paid rungs with **no wallet of
 * their own** — you pass the resulting fetch straight into quickCheck/autoReceipt.
 *
 * Two sponsorship models plug into `settle`:
 *   1. GAS-SPONSORED (live today via @x402/svm): the agent signs+pays USDC and the
 *      resource server's feePayer (challenge `extra.feePayer`) covers the SOL gas.
 *      `settle` = the agent's @x402/svm `ExactSvmScheme` fetch. Agent needs USDC,
 *      not SOL. (This is exactly what twzrd-mcp-server does.)
 *   2. FULL-SPONSOR (the no-wallet goal): `settle` = a POST to a TWZRD-hosted
 *      sponsor endpoint that pays the $0.05/$0.001 from a TREASURY wallet on the
 *      agent's behalf. That endpoint + treasury is FOUNDER-GATED (who funds it,
 *      and per-agent budget/abuse caps). This file is the client seam + a dry-run
 *      so the wiring is ready the moment the sponsor backend exists.
 *
 * Dependency-free: `settle` is yours to supply; use `dryRun` for a no-spend mock.
 * This is a PROTOTYPE — it never funds or signs anything itself.
 */
function urlOf(input) {
    if (typeof input === "string")
        return input;
    if (input instanceof URL)
        return input.href;
    return input.url;
}
/**
 * Build an `x402Fetch` that delegates settlement to a sponsor. Pass the result as
 * `x402Fetch` to `quickCheck` / `autoReceipt`:
 *
 *   const x402Fetch = createSponsoredX402Fetch({ settle: agentSvmFetch });
 *   await quickCheck(seller, { x402Fetch });   // sponsor pays the $0.001
 *
 * Never throws on construction; in dryRun (or with no `settle`) it returns a mock
 * 200 so the seam is demonstrable without spending.
 */
export function createSponsoredX402Fetch(opts = {}) {
    const { settle, dryRun, onSettle, dryRunBody } = opts;
    return (async (input, init) => {
        const url = urlOf(input);
        onSettle?.(url);
        if (dryRun || typeof settle !== "function") {
            const body = dryRunBody ?? { sponsored_dry_run: true, url };
            return new Response(JSON.stringify(body), {
                status: 200, headers: { "content-type": "application/json" },
            });
        }
        return settle(url, init);
    });
}
//# sourceMappingURL=sponsored.js.map