import { generateKeyPairSync } from "node:crypto";
import { applyPolicy, createLoop, createPaymentIntent, issueReceipt, markDelivery, markPaymentFailed, markPaymentSigned, markSettled, verifyReceipt } from "./index.js";
export function simulate(options) {
    const loop = createLoop(options.input);
    let signerInvocations = 0;
    applyPolicy(loop, options.decision, [`simulated_${options.decision}`], `preflight:${loop.loop_id}`);
    if (options.decision === "block")
        return { loop, signerInvocations };
    createPaymentIntent(loop);
    signerInvocations += 1;
    markPaymentSigned(loop, `sig:sim:${loop.loop_id}`);
    if (options.paymentSucceeds === false) {
        markPaymentFailed(loop, "simulated_payment_failure");
        return { loop, signerInvocations };
    }
    markSettled(loop, `settlement:sim:${loop.loop_id}`);
    markDelivery(loop, options.deliverySucceeds !== false, options.deliverySucceeds === false ? "simulated_delivery_failure" : `delivery:sim:${loop.loop_id}`);
    const { privateKey } = generateKeyPairSync("ed25519");
    issueReceipt(loop, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "did:key:simulator");
    verifyReceipt(loop);
    return { loop, signerInvocations };
}
