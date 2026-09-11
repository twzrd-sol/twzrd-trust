#!/usr/bin/env node
import { exportEvidence } from "./evidence.js";
import { simulate } from "./simulator.js";
const activity = (process.argv[2] ?? "external");
const decision = (process.argv[3] ?? "allow");
const result = simulate({ decision, input: { loop_id: `loop-${Date.now()}`, resource: { id: "demo", uri: "https://example.test/resource", version: "1" }, parties: { payer: "agent:buyer", seller: "agent:seller", facilitator: null, custody: "self_custody" }, activity, price: { amount: "0.01", asset: "USDC", network: "solana" } } });
console.log(JSON.stringify({ signer_invocations: result.signerInvocations, evidence: exportEvidence(result.loop) }, null, 2));
