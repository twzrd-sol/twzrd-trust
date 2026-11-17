// Manual run against a real seller (devnet or testnet). Never part of
// `npm run ci`: it is skipped unless TWZRD_E2E_LIVE=1, and it spends from
// whatever wallet your pay module holds.
//
//   TWZRD_E2E_LIVE=1 \
//   TWZRD_E2E_URL=https://seller.example/paid \
//   TWZRD_E2E_PAY_MODULE=/abs/path/pay.mjs \   # exports wrapPay(guardedFetch) -> fetch
//   TWZRD_E2E_MAX_USD=0.01 \                    # per-call cap and total budget (default 0.01)
//   TWZRD_E2E_INTEL_BASE=https://intel.twzrd.xyz \
//   npm run e2e:devnet
//
// It runs the same pipeline as pipeline.test.mjs with the real intel service
// and your signer, then checks that the tool ledger and the gate's spend
// ledger agree. The seller's own total is not available, and a seller that
// returns no TWZRD receipt in its body reports `receipt_rejected`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { createPipeline, tempState } from "./lib.mjs";

const live = process.env.TWZRD_E2E_LIVE === "1";

test("live: one paid call through the pipeline against a real seller", { skip: live ? false : "set TWZRD_E2E_LIVE=1 to run" }, async () => {
  const url = process.env.TWZRD_E2E_URL;
  const payModule = process.env.TWZRD_E2E_PAY_MODULE;
  assert.ok(url && payModule, "TWZRD_E2E_URL and TWZRD_E2E_PAY_MODULE are required");
  const maxUsd = Number(process.env.TWZRD_E2E_MAX_USD ?? "0.01");
  assert.ok(Number.isFinite(maxUsd) && maxUsd > 0, "TWZRD_E2E_MAX_USD must be a positive number");
  const { wrapPay } = await import(pathToFileURL(payModule).href);
  assert.equal(typeof wrapPay, "function", "the pay module must export wrapPay(guardedFetch)");

  const state = tempState();
  const world = { base: process.env.TWZRD_E2E_INTEL_BASE ?? "https://intel.twzrd.xyz", url };
  const p = createPipeline({
    state,
    world,
    signer: { wrapPay },
    limits: { maxCostPerCallUsd: maxUsd, maxUsdPerHour: maxUsd, maxUsdPerDay: maxUsd },
    policy: { maxAmountUsd: String(maxUsd), dailyCeilingUsd: String(maxUsd) },
    fetchImpl: fetch,
  });
  const { settlement, trace } = await p.buy({ requestId: "live-1" });
  console.log(`trace: ${trace.join(" -> ")}; billed ${settlement.costUsd} USD; state kept in ${state.dir}`);
  assert.ok(trace.includes("payment"));
  const toolMicro = Math.round(p.guard.spend().dayUsd * 1e6);
  const gateRows = fs.readFileSync(state.gateLedger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const gateMicro = gateRows.filter((r) => r.scope === "policy:global").reduce((sum, r) => sum + Number(r.micro), 0);
  assert.equal(toolMicro, gateMicro, "the tool ledger and the gate's spend ledger must agree");
});
