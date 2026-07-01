import type { X402PaymentRequirements } from "./types.js";
/**
 * Pick the best payment requirements from an x402 accepts[] array.
 * Prefers the Solana-network entry when multiple networks are listed
 * (e.g. CDP 402 bodies list EVM first, Solana second).
 */
export declare function pickRequirements(accepts?: Array<Record<string, unknown>>): X402PaymentRequirements;
export declare function payToFromRequirements(req: X402PaymentRequirements): {
    payTo: string | undefined;
    amountMicro: string | undefined;
    resource: string | undefined;
};
export declare function priceUsdcFromAmountMicro(amountMicro: string | undefined): number | undefined;
//# sourceMappingURL=payto.d.ts.map