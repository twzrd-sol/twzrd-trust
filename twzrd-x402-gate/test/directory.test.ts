import assert from "node:assert/strict";

import {
  listDirectoryCallables,
  listResources,
  listX402Directory,
  normalizeDirectoryRow,
  pickCallable,
} from "../src/directory.js";

async function run() {
  const row = normalizeDirectoryRow(
    {
      resource_url: "https://merchant.example/paid",
      pay_to: "PayTo111111111111111111111111111111111111111",
      live_402: true,
      listed: true,
      name: "demo",
    },
    "resources",
  );
  assert.equal(row.resourceUrl, "https://merchant.example/paid");
  assert.equal(row.payTo, "PayTo111111111111111111111111111111111111111");
  assert.equal(row.live402, true);
  assert.equal(row.source, "resources");

  const picked = pickCallable([
    { resourceUrl: "https://a", payTo: null, live402: true, listed: true, name: "a", source: "resources" },
    { resourceUrl: "https://b", payTo: "Bpay", live402: false, listed: true, name: "b", source: "resources" },
    { resourceUrl: "https://c", payTo: "Cpay", live402: true, listed: true, name: "c", source: "x402-directory" },
  ]);
  assert.equal(picked?.payTo, "Cpay");
  assert.equal(pickCallable([]), null);

  const calls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    calls.push(String(url));
    const href = String(url);
    const body = href.includes("/resources")
      ? {
          resources: [
            { url: "https://svc.example/x", payTo: "Seller1111111111111111111111111111111111111", live_402: true },
          ],
        }
      : { items: [{ resource_url: "https://bazaar.example/y", seller_wallet: "Other" }] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const resources = await listResources({ fetch: fetchImpl, intelBase: "https://intel.example", limit: 5 });
  assert.equal(resources[0]?.payTo?.startsWith("Seller"), true);
  assert.ok(calls[0]?.includes("/v1/intel/resources?limit=5"));

  const overlay = await listX402Directory({ fetch: fetchImpl, intelBase: "https://intel.example" });
  assert.equal(overlay[0]?.source, "x402-directory");
  assert.ok(calls.some((u) => u.includes("/v1/intel/x402-directory")));

  const merged = await listDirectoryCallables({ fetch: fetchImpl, intelBase: "https://intel.example" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.source, "resources");

  const emptyThenOverlay = await listDirectoryCallables({
    intelBase: "https://intel.example",
    fetch: (async (url: unknown) => {
      const href = String(url);
      if (href.includes("/resources")) {
        return new Response(JSON.stringify({ resources: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ items: [{ url: "https://fallback.example", pay_to: "Fb" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });
  assert.equal(emptyThenOverlay[0]?.payTo, "Fb");

  console.log("directory.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
