#!/usr/bin/env node
import { exportEvidence } from "./evidence.js";
import { replay } from "./index.js";
import { simulate } from "./simulator.js";
const tools = [
    { name: "agent_commerce_simulate", description: "Run the complete Agent Commerce Loop locally without broadcasting payment", inputSchema: { type: "object", required: ["input", "decision"], properties: { input: { type: "object" }, decision: { enum: ["allow", "warn", "block"] }, paymentSucceeds: { type: "boolean" }, deliverySucceeds: { type: "boolean" } } } },
    { name: "agent_commerce_replay", description: "Replay and validate a recorded journey with zero spend", inputSchema: { type: "object", required: ["events"], properties: { events: { type: "array" } } } }
];
for await (const line of process.stdin) {
    try {
        const request = JSON.parse(line);
        let result;
        if (request.method === "tools/list")
            result = { tools };
        else if (request.method === "tools/call" && request.params?.name === "agent_commerce_simulate") {
            const run = simulate(request.params.arguments);
            result = { content: [{ type: "text", text: JSON.stringify(exportEvidence(run.loop)) }] };
        }
        else if (request.method === "tools/call" && request.params?.name === "agent_commerce_replay")
            result = { content: [{ type: "text", text: JSON.stringify(replay(request.params.arguments.events)) }] };
        else
            throw new Error("method_or_tool_not_found");
        console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    }
    catch (error) {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));
    }
}
