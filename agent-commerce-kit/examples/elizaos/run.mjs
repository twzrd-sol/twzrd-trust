#!/usr/bin/env node
import { createAgentCommercePlugin } from "./plugin.mjs";

const offline = process.argv.includes("--offline");
const activityArg = process.argv.find(arg => arg.startsWith("--activity="));
const activity = activityArg?.split("=")[1] ?? process.env.TWZRD_ACTIVITY ?? "external";
const plugin = createAgentCommercePlugin({ offline, activity });
const action = plugin.actions.find(item => item.name === "TWZRD_AGENT_COMMERCE_JOURNEY");
const result = await action.handler({ getSetting: key => process.env[key] }, { content: { text: "Discover merchants and run the commerce loop" } }, undefined, { runId: process.env.TWZRD_RUN_ID });
const compact = {
  framework: result.data.framework,
  activity: result.data.activity,
  discovered: result.data.discovered,
  journeys: result.data.journeys.map(({ merchant, preflight, signer_invocations, evidence }) => ({ merchant: merchant.name, decision: preflight.decision, payment: evidence.outcome.payment, delivery: evidence.outcome.delivery, verified: evidence.outcome.attribution === "verified", signer_invocations, evidence_ref: evidence.refs[0] ?? null }))
};
console.log(JSON.stringify(compact, null, 2));
