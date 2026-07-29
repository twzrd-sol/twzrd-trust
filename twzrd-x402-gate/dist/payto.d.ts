import type { X402PaymentRequirements } from "./types.js";
/**
 * Pick the best payment requirements from an x402 accepts[] array.
 * Prefers the Solana-network entry when multiple networks are listed
 * (e.g. CDP 402 bodies list EVM first, Solana second).
 */
/**
 * TWZRD's own facilitator fee payer (== its GET /supported feePayer). Exported so
 * a caller can pass `preferFeePayer: TWZRD_FEE_PAYER`, or set the env alias
 * `TWZRD_PREFER_FEE_PAYER=twzrd`.
 */
export declare const TWZRD_FEE_PAYER = "4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE";
export declare function pickRequirements(accepts?: Array<Record<string, unknown>>, opts?: {
    preferFeePayer?: string;
}): X402PaymentRequirements;
export declare function payToFromRequirements(req: X402PaymentRequirements): {
    payTo: string | undefined;
    amountMicro: string | undefined;
    resource: string | undefined;
};
export declare function priceUsdcFromAmountMicro(amountMicro: string | undefined): number | undefined;
//# sourceMappingURL=payto.d.ts.map