/**
 * `twzrd-x402-gate/cloudflare-base` on a Node without `process.getBuiltinModule`
 * (before 20.16 / 22.3; the package supports Node 18). The module has no import
 * statement for `fs`, so on those versions it must reach it another way and
 * still stop at `.kill`.
 *
 * Own file on purpose: the module resolves the host filesystem once per
 * process, so this has to run before anything else imports it.
 * Run: npx tsx --test test/cloudflare-base-sentinel-old-node.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PAY_TO = "0x3803A19280DeeFe533D177C4A169412BD341101b";
const REQUIREMENTS = {
  resource: "https://worker.example/paid-tool",
  accepts: [{ network: "eip155:8453", payTo: PAY_TO, amount: "1000" }],
};
const allow = (async () =>
  new Response(JSON.stringify({ readiness_card: { decision: "allow", trust_score: 90 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

test("cloudflare-base reads .kill on a Node that has no process.getBuiltinModule", async () => {
  const original = (process as { getBuiltinModule?: unknown }).getBuiltinModule;
  (process as { getBuiltinModule?: unknown }).getBuiltinModule = undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-old-node-"));
  try {
    const { createTwzrdCloudflareBaseApproval, withTwzrdBasePreflight, TwzrdBasePaymentBlockedError } = await import(
      "../src/cloudflare-base.js"
    );
    const options = { intelBase: "https://intel.fixture", fetch: allow, stateDir: dir };
    const approve = createTwzrdCloudflareBaseApproval(options);
    assert.equal(await approve(REQUIREMENTS), true, "control");

    fs.writeFileSync(path.join(dir, ".kill"), "halt\n");
    assert.equal(await approve(REQUIREMENTS), false, "approval returned true past .kill");
    let signatures = 0;
    await assert.rejects(
      () => withTwzrdBasePreflight(REQUIREMENTS, options, async () => { signatures += 1; return "0xsignature"; }),
      (e: unknown) => e instanceof TwzrdBasePaymentBlockedError && e.verdict.reasons.includes("twzrd_kill_switch"),
    );
    assert.equal(signatures, 0);
  } finally {
    (process as { getBuiltinModule?: unknown }).getBuiltinModule = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
