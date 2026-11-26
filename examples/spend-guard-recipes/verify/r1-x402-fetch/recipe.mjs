// Recipe 1: @x402/fetch with the twzrd-x402-gate@0.28.1 spend guard.
// `client` is the x402Client you already hand to wrapFetchWithPayment, with your scheme and signer registered.
import { createBuyerFetch } from "twzrd-x402-gate";

// was: const pay = wrapFetchWithPayment(fetch, client);
export const guardedPay = (client, sellerPayTo, testOnly = {}) =>
  createBuyerFetch({ client, maxPricePerCall: "0.01", allowedRecipients: [sellerPayTo], ...testOnly });
