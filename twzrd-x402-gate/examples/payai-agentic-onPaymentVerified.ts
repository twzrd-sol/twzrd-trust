/**
 * PayAI agentic-payments merchant example: screen payers with TWZRD.
 *
 * Uses the existing `onPaymentVerified` hook in @payai/agentic-payments
 * (the active SDK, not the dormant x402-solana). TWZRD screens the PAYER
 * (who paid you) so your demand-quality reputation stays clean. Fail-open
 * by default — never block revenue on intel outage.
 *
 * Adapter exports (shipped in twzrd-x402-gate@0.8.16):
 *   createTwzrdSettleGuard / twzrdPayerScreen / toPayaiVerifyResult
 *
 * Usage:
 *   npm install @payai/agentic-payments twzrd-x402-gate@0.9.2
 *   npx tsx examples/payai-agentic-onPaymentVerified.ts
 */
import { AgentPayments } from "@payai/agentic-payments";
import {
  createTwzrdSettleGuard,
  twzrdPayerScreen,
  toPayaiVerifyResult,
} from "twzrd-x402-gate";

// 1. Create the guard (fail-open: intel outage → allow, not reject)
const guard = createTwzrdSettleGuard({
  screen: twzrdPayerScreen(),
  // failOpen: true,   // default — don't block revenue on TWZRD downtime
});

// 2. Wire it into agentic-payments lifecycle
const ap = new AgentPayments({
  payTo: {
    evm: process.env.PAY_TO_EVM ?? "0x...",
    solana: process.env.PAY_TO_SVM ?? "ExamP1eWaLLet1111111111111111111111111111111",
  },
  endpoints: {
    "GET /weather": { price: "$0.01", description: "Current weather" },
  },
  hooks: {
    onPaymentVerified: async (ctx) => {
      // Map PayAI context → TWZRD SettleGuardContext
      const result = await guard({
        paymentPayload: { payload: { payer: ctx.payment.payer } },
        requirements: {},
      });
      // Convert to PayAI { reject, reason } shape
      return toPayaiVerifyResult(result);
    },
  },
});

// 3. Serve
ap.listen(4000, () => {
  console.log("[payai+twzrd] listening on :4000 — payers screened by TWZRD");
});
