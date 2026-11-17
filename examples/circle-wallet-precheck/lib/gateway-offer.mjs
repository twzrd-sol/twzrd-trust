// Circle Gateway's x402 offer on Base, and the EIP-712 authorization a buyer
// signs for it. Shapes follow Circle's docs: GET /v1/x402/supported and the
// nanopayments EIP-3009 signing how-to (domain "GatewayWalletBatched").

export const GATEWAY_SUPPORTED_URL = "https://gateway-api.circle.com/v1/x402/supported";
export const BASE = "eip155:8453";
const BASE_CHAIN_ID = 8453;
const THREE_DAYS = 3 * 24 * 3600;

/** The Base USDC kind from Circle's live supported list. Throws when it is missing. */
export function baseUsdcKind(supported) {
  const kinds = Array.isArray(supported?.kinds) ? supported.kinds : [];
  const kind = kinds.find(
    (k) => k.scheme === "exact" && k.network === BASE && k.extra?.name === "GatewayWalletBatched",
  );
  if (!kind) throw new Error("Circle Gateway lists no GatewayWalletBatched kind on Base");
  const usdc = (kind.extra.assets ?? []).find((a) => a.symbol === "USDC");
  if (!usdc || usdc.decimals !== 6) {
    throw new Error("Circle Gateway's Base kind has no 6-decimal USDC asset");
  }
  return {
    network: BASE,
    chainId: BASE_CHAIN_ID,
    verifyingContract: kind.extra.verifyingContract,
    minValiditySeconds: Number(kind.extra.minValiditySeconds ?? THREE_DAYS),
    usdc: usdc.address,
  };
}

/** A seller's 402 payment option, as a Gateway seller would offer it. */
export function offerFor(kind, { payTo, priceUsdc, resource }) {
  return {
    scheme: "exact",
    network: kind.network,
    asset: kind.usdc,
    amount: String(Math.round(priceUsdc * 1_000_000)),
    payTo,
    resource,
    maxTimeoutSeconds: 60,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: kind.verifyingContract },
  };
}

/**
 * The TransferWithAuthorization the buyer's wallet signs. The timing follows
 * Circle's own client (@circle-fin/x402-batching 4.0.0, BatchEvmScheme):
 * validAfter is ten minutes back, and validBefore is Gateway's minimum
 * validity (minValiditySeconds from the supported list, never under three
 * days) plus a 100-second buffer.
 */
export function authorizationTypedData(kind, offer, { from, nowSeconds, nonce }) {
  const validity = Math.max(kind.minValiditySeconds, THREE_DAYS) + 100;
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    domain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId: kind.chainId,
      verifyingContract: kind.verifyingContract,
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to: offer.payTo,
      value: offer.amount,
      validAfter: String(nowSeconds - 600),
      validBefore: String(nowSeconds + validity),
      nonce,
    },
  };
}
