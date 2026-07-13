/**
 * TWZRD Payment Control — protocol adapters into PaymentIntent v1.
 *
 * Adapters normalize protocol-specific payment shapes into the one canonical
 * intent the policy runtime evaluates. The x402 adapter keeps the existing
 * gate's behavior available on the new core; the AP2/UCP adapter is the
 * non-x402 reference — it exists to prove the runtime combines a USER MANDATE
 * with counterparty risk, not merely that it parses another crypto request.
 */
import type { PaymentIntent } from "./intent.js";
import type { Mandate } from "./policy-runtime.js";
import type { X402SelectedRequirements } from "./x402-client-hook.js";
export type X402IntentContext = {
    /** Resource URL when the requirement omits `resource` (v2 top-level). */
    resourceUrl?: string;
    method?: string;
    facilitator?: string;
    agent?: PaymentIntent["agent"];
    purpose?: string;
    /**
     * Decimals of the wire asset, for converting the x402 base-unit amount into
     * the decimal-USD string PaymentIntent.amount requires. Default 6 (USDC),
     * matching the gate's Solana-USDC assumption.
     */
    decimals?: number;
};
/** Normalize a selected x402 payment requirement (v1 or v2 field names). */
export declare function x402RequirementsToIntent(req: X402SelectedRequirements, ctx?: X402IntentContext): PaymentIntent;
/**
 * Minimal AP2-style cart: what an agent is about to check out under a user
 * mandate. Field names follow the AP2 mandate/cart split — the mandate says
 * what MAY be spent; the cart is the concrete transaction.
 */
export type Ap2Cart = {
    merchantId: string;
    /** Settlement destination (merchant account / wallet). */
    payTo: string;
    currency: string;
    total: string;
    items?: Array<{
        sku?: string;
        description?: string;
        price?: string;
    }>;
    checkoutUrl?: string;
    category?: string;
    recurring?: boolean;
    priorCharge?: string;
};
export type Ap2UserMandate = {
    mandateId: string;
    /** Purchase categories the user authorized (e.g. ["software"]). */
    categories?: string[];
    maxPerTransaction?: string;
    monthlyCeiling?: string;
    merchantAllowPrefixes?: string[];
    expiresAt?: string;
};
/** Cart -> canonical intent. The mandate rides along for the policy runtime. */
export declare function ap2CheckoutToIntent(cart: Ap2Cart, mandate: Ap2UserMandate, options?: {
    network?: string;
    agentId?: string;
    organization?: string;
}): {
    intent: PaymentIntent;
    mandate: Mandate;
};
//# sourceMappingURL=intent-adapters.d.ts.map