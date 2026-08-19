/**
 * Host-configurable Path A receipt policy (V6 / $0.05 trust endpoint).
 *
 * Free preflight still decides allow|warn|block. This policy only decides when
 * the host should auto-purchase a paid portable receipt, and whether failure
 * of that purchase should harden into a deny (true incentive loop).
 */
import type { TwzrdDecision } from "./types.js";
/** Default spend threshold (USD) above which Path A is required when enabled. */
export declare const DEFAULT_REQUIRE_RECEIPT_MIN_SPEND_USDC = 10;
export type RequireReceiptPolicy = {
    /**
     * Auto-require Path A when resource `priceUsdc` is strictly greater than this.
     * Default: 10. Set to 0 to treat any positive price as high-value.
     */
    minSpendUsdc?: number;
    /**
     * When true (default), also require Path A on free preflight `decision === "warn"`.
     * Never requires on `block` (free refuse stays free).
     */
    onWarn?: boolean;
    /**
     * When true (default), deny/abort the merchant payment if Path A cannot be
     * obtained. When false, soft upsell: attempt purchase but allow proceed.
     */
    hard?: boolean;
    /**
     * When true, `onWarn` only fires if `priceUsdc >= minSpendUsdc`.
     * Default false (legacy: any warn). Buyer install default sets true.
     */
    materialWarnOnly?: boolean;
};
export type ResolvedRequireReceiptPolicy = {
    minSpendUsdc: number;
    onWarn: boolean;
    hard: boolean;
    materialWarnOnly: boolean;
};
/**
 * Normalize host config: `true` → defaults; object → merge defaults; false/omit → null.
 */
export declare function resolveRequireReceiptPolicy(raw: boolean | RequireReceiptPolicy | undefined): ResolvedRequireReceiptPolicy | null;
/**
 * Whether Path A should run for this free decision + resource price.
 * Never for `block` (and not for non-proceeding unknown/block paths).
 */
export declare function shouldRequirePathAReceipt(input: {
    policy: ResolvedRequireReceiptPolicy | null;
    decision: TwzrdDecision | "unknown" | string | null | undefined;
    priceUsdc?: number | null;
}): boolean;
/**
 * Whether to attempt Path A purchase (explicit autoReceipt or threshold trigger).
 * Still never on block.
 */
export declare function shouldAttemptPathAReceipt(input: {
    autoReceipt?: boolean;
    requireReceipt?: boolean | RequireReceiptPolicy;
    decision: TwzrdDecision | "unknown" | string | null | undefined;
    priceUsdc?: number | null;
}): boolean;
//# sourceMappingURL=receipt-policy.d.ts.map