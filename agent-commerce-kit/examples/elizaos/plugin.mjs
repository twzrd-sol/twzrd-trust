import { exportEvidence } from "@twzrd/agent-commerce-kit";
import { simulate } from "@twzrd/agent-commerce-kit/dist/simulator.js";
import { discoverMerchants } from "./merchant-catalog.mjs";
import { createMetrics } from "./metrics.mjs";
import { twzrdPreflight } from "./preflight.mjs";

export function createAgentCommercePlugin({ offline = false, activity = "external", metricSink, fetchImpl } = {}) {
  const action = {
    name: "TWZRD_AGENT_COMMERCE_JOURNEY",
    similes: ["BUY_FROM_DISCOVERED_AGENT", "RUN_AGENT_COMMERCE_LOOP"],
    description: "Discover merchants, preflight each seller, block unsafe payment paths, and export verified journey evidence.",
    examples: [],
    validate: async () => true,
    handler: async (runtime, message, state, options = {}, callback) => {
      const runId = options.runId ?? `eliza-${Date.now()}`;
      const emit = createMetrics({ activity, runId, sink: metricSink });
      const catalog = await discoverMerchants();
      const journeys = [];
      await emit("kit_install", { framework: "elizaos", example_version: "0.1.0" });

      for (const merchant of catalog) {
        const card = await twzrdPreflight(merchant, { fetchImpl, offline });
        await emit("preflight_call", { merchant_id: merchant.id, decision: card.decision, source: card.source });
        const decision = card.decision === "block" ? "block" : card.decision === "warn" ? "warn" : "allow";
        const simulation = simulate({
          decision,
          input: {
            loop_id: `${runId}:${merchant.id}`,
            resource: { id: merchant.id, uri: merchant.resource, version: "catalog-v1" },
            parties: { payer: "did:agent:eliza-example", seller: merchant.seller, facilitator: null, custody: "self_custody" },
            activity,
            price: { amount: "0.01", asset: "USDC", network: "solana" }
          }
        });
        await emit("simulator_run", { merchant_id: merchant.id, signer_invocations: simulation.signerInvocations });
        const evidence = exportEvidence(simulation.loop);
        if (evidence.outcome.attribution === "verified") await emit("verified_journey", { merchant_id: merchant.id, receipt_ref: evidence.refs[0] });
        journeys.push({ merchant, preflight: card, signer_invocations: simulation.signerInvocations, evidence });
      }

      const result = { framework: "elizaos", activity, run_id: runId, discovered: catalog.length, journeys };
      await callback?.({ text: JSON.stringify(result, null, 2), content: result });
      return { success: true, data: result };
    }
  };
  return { name: "twzrd-agent-commerce-example", description: "End-to-end Agent Commerce Kit example for ElizaOS", actions: [action] };
}

export default createAgentCommercePlugin();
