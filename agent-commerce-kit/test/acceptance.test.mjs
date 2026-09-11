import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { exportEvidence, replay, verifyReceipt } from "../dist/index.js";
import { simulate } from "../dist/simulator.js";

const input = activity => ({ loop_id: `loop-${activity}`, resource: { id: "weather", uri: "https://seller.test/weather", version: "sha256:abc" }, parties: { payer: "did:agent:buyer", seller: "did:agent:seller", facilitator: "did:agent:facilitator", custody: "facilitated_non_custodial" }, activity, price: { amount: "0.01", asset: "USDC", network: "solana" } });

test("blocked sellers never receive a payment signature", () => {
  const { loop, signerInvocations } = simulate({ input: input("external"), decision: "block" });
  assert.equal(signerInvocations, 0); assert.equal(loop.payment.status, "blocked"); assert.equal(loop.payment.intent_ref, null); assert.equal(loop.payment.signature_ref, null);
});
test("Python client also enforces block before payment intent", () => {
  const script = "from agent_commerce import create_loop,apply_policy,create_payment_intent; l=create_loop(loop_id='py-loop',resource={'id':'r','uri':'https://x','version':'1'},parties={'payer':'p','seller':'s','facilitator':None,'custody':'self_custody'},activity='house',price={'amount':'1','asset':'USDC','network':'solana'}); apply_policy(l,'block',['risk'],'pf:1');\ntry: create_payment_intent(l)\nexcept ValueError: print(l['payment']['status'], l['payment']['signature_ref'])";
  const py = spawnSync("python3", ["-c", `import sys; sys.path.insert(0,'python'); ${script}`], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr); assert.equal(py.stdout.trim(), "blocked None");
});
test("allowed payments produce receipts verifiable in TypeScript and Python", () => {
  const { loop } = simulate({ input: input("external"), decision: "allow" });
  assert.equal(loop.payment.status, "settled"); assert.equal(loop.attribution.status, "verified"); assert.equal(verifyReceipt(loop), true);
  const py = spawnSync("python3", ["-c", "import json,sys; sys.path.insert(0,'python'); from agent_commerce import verify_receipt; print(json.dumps(verify_receipt(json.load(sys.stdin))))"], { cwd: new URL("..", import.meta.url), input: JSON.stringify(loop), encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr); assert.equal(JSON.parse(py.stdout), true);
});
test("failed delivery is distinct from failed payment", () => {
  const paymentFailure = simulate({ input: input("external"), decision: "allow", paymentSucceeds: false }).loop;
  const deliveryFailure = simulate({ input: { ...input("external"), loop_id: "loop-delivery-failure" }, decision: "allow", deliverySucceeds: false }).loop;
  assert.equal(paymentFailure.payment.status, "failed"); assert.equal(paymentFailure.delivery.status, "not_started");
  assert.equal(deliveryFailure.payment.status, "settled"); assert.equal(deliveryFailure.delivery.status, "failed"); assert.equal(verifyReceipt(deliveryFailure), true);
});
test("house, sponsored, and external activity remain explicit and unequal", () => {
  const bundles = ["house", "sponsored", "external"].map(activity => exportEvidence(simulate({ input: input(activity), decision: "allow" }).loop));
  assert.deepEqual(bundles.map(bundle => bundle.activity), ["house", "sponsored", "external"]);
  assert.equal(new Set(bundles.map(bundle => bundle.loop.activity)).size, 3);
});
test("the entire journey replays without spending", () => {
  const { loop } = simulate({ input: input("external"), decision: "allow" }); const result = replay(loop.events);
  assert.equal(result.valid, true); assert.equal(result.spend_attempts, 0); assert.deepEqual(result.stages, ["discover","preflight","policy_decision","payment_intent","settlement","delivery","signed_receipt","outcome_evidence"]);
});
