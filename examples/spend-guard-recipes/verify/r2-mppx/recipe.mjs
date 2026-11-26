// Recipe 2: mppx with the twzrd-x402-gate@0.28.1 spend guard on onChallenge.
// `account` is your viem account. Do not also register an onChallengeReceived handler that returns
// a credential: mppx uses that credential first and the guard never runs.
import { Mppx, tempo } from "mppx/client";
import { installTwzrdAutoGate, createLocalDecisionSigner } from "twzrd-x402-gate";

export const guardedMppx = (account, testOnly = {}) => {
  const onChallenge = installTwzrdAutoGate("mpp", { signer: createLocalDecisionSigner(), policy: { maxAmountUsd: "0.01" }, ...testOnly.gate });
  return Mppx.create({ methods: [tempo({ account })], polyfill: false, onChallenge: testOnly.instrument?.(onChallenge) ?? onChallenge, ...testOnly.mppx });
};
