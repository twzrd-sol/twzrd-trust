#!/usr/bin/env node
/** Verify the packed install and restart budget in an isolated consumer. No live payment. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = join(root, "..");
const temp = mkdtempSync(join(tmpdir(), "twzrd-buyer-consumer-"));
const consumer = join(temp, "consumer");
mkdirSync(consumer);
function run(command, args, cwd = consumer) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
run("npm", ["run", "build"], root);
const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], root))[0];
const tarball = join(temp, packed.filename);
writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
const version = name => JSON.parse(readFileSync(join(workspace, "node_modules", name, "package.json"), "utf8")).version;
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball,
  `@x402/core@${version("@x402/core")}`, `@x402/fetch@${version("@x402/fetch")}`]);

const demo = JSON.parse(run(process.execPath, ["node_modules/.bin/twzrd-buyer-demo"]));
assert.equal(demo.mode, "offline_fixture");
assert.equal(demo.reason, "price_cap_exceeded");
assert.equal(demo.signer_invocations, 0);
assert.equal(demo.paid_requests, 0);
assert.equal(demo.usdc_spent, 0);
const demoRow = JSON.parse(readFileSync(demo.decision_file, "utf8").trim());
assert.deepEqual(demoRow.reason_codes, ["price_cap_exceeded"]);

// These two fresh Node processes share only the local files, not module caches.
writeFileSync(join(consumer, "budget.mjs"), `
import assert from "node:assert/strict";
import { x402Client } from "@x402/fetch";
import { createBuyerFetch, BuyerFetchBlockedError } from "twzrd-x402-gate";
const network = "eip155:8453";
const seller = "0x1111111111111111111111111111111111111111";
let signs = 0;
const client = new x402Client();
client.setSpendControls(false);
client.register(network, { scheme: "exact", async createPaymentPayload(version) {
  signs++;
  return { x402Version: version, payload: { synthetic: true } };
} });
const guarded = createBuyerFetch({ client, maxPricePerCall: "0.05",
  hourlyBudgetCap: "0.05", allowedRecipients: [seller],
  fetch: async (input, init) => {
    const request = new Request(input, init);
    if (request.url.includes("/preflight")) return Response.json({ readiness_card: { decision: "allow", trust_score: 90 } });
    if (request.url.includes("/merchant_card/")) return Response.json({ wash_flagged: false });
    if (request.headers.has("payment-signature")) return Response.json({ synthetic: true });
    return new Response(null, { status: 402, headers: {
      "payment-required": Buffer.from(JSON.stringify({ x402Version: 2,
        resource: { url: "https://merchant.example/paid" }, accepts: [{ scheme: "exact",
          network, payTo: seller, amount: "30000", maxTimeoutSeconds: 60,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", extra: {} }],
      })).toString("base64"),
    } });
  },
});
if (process.argv[2] === "first") {
  assert.equal((await guarded("https://merchant.example/paid")).status, 200);
  assert.equal(signs, 1);
} else {
  await assert.rejects(guarded("https://merchant.example/paid"), error =>
    error instanceof BuyerFetchBlockedError && error.reason === "hourly_budget_exceeded");
  assert.equal(signs, 0);
}
console.log(JSON.stringify({ phase: process.argv[2], signer_invocations: signs, mode: "offline_fixture" }));
`);
const first = JSON.parse(run(process.execPath, ["budget.mjs", "first"]));
const restarted = JSON.parse(run(process.execPath, ["budget.mjs", "restarted"]));
const retainedTarball = join(root, packed.filename);
copyFileSync(tarball, retainedTarball);
console.log(JSON.stringify({
  result: "passed", mode: "offline_fixture", demo,
  restart_budget: [first, restarted], tarball: retainedTarball,
  integrity: packed.integrity, consumer_directory: consumer,
  outside_use_established: false,
}, null, 2));
