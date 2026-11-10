/**
 * `twzrd-x402-gate/cloudflare-base` inside a Worker. A Worker has no host
 * filesystem: nobody can drop a `.kill` where it would be seen, and with
 * `nodejs_compat` its `fs` is an in-memory stand-in. The module therefore
 * reads no sentinel there. This pins that as a decision, and pins that the
 * decision is keyed on the Worker runtime's own name and on nothing a Node
 * host reports.
 *
 * Own file on purpose: the module resolves the host filesystem once per
 * process, so the runtime has to look like a Worker before the first import.
 * Run: npx tsx --test test/cloudflare-base-sentinel-worker.test.ts
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

test("cloudflare-base reads no sentinel when the runtime is a Worker", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Cloudflare-Workers" }, configurable: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-worker-"));
  const reads: string[] = [];
  const realStat = fs.statSync;
  try {
    const { createTwzrdCloudflareBaseApproval } = await import("../src/cloudflare-base.js");
    fs.writeFileSync(path.join(dir, ".kill"), "halt\n");
    const approve = createTwzrdCloudflareBaseApproval({ intelBase: "https://intel.fixture", fetch: allow, stateDir: dir });
    (fs as { statSync: unknown }).statSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      reads.push(String(p));
      return (realStat as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.statSync;
    assert.equal(await approve(REQUIREMENTS), true, "a Worker has no host filesystem to halt it from");
    assert.deepEqual(reads, [], "the Worker path touched the filesystem");
  } finally {
    (fs as { statSync: unknown }).statSync = realStat;
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as { navigator?: unknown }).navigator;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
