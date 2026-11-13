/**
 * The pinned fetch connects to the addresses it was given and to nothing else.
 *
 * The cold-start probe checks what a directory-listed hostname resolves to and
 * then fetches it. With an ordinary fetch the name is resolved a second time
 * at connect, and a name whose answer changes in between (DNS rebinding)
 * takes the probe to a private address the check never saw.
 *
 * Loopback sockets only: every server here listens on 127.0.0.1, and no name
 * is ever sent to DNS (that is the property under test).
 *
 * Run: npx tsx --test test/pinned-fetch.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { test } from "node:test";

import { createPinnedFetch, pinnedLookup } from "../src/ssrf.js";

const LOOPBACK = [{ address: "127.0.0.1", family: 4 }];

type Seen = { host: string | undefined; url: string | undefined; headers: IncomingMessage["headers"] };

async function listen(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen[]) => void) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url, headers: req.headers });
    handler(req, res, seen);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return { port, seen, close };
}

const answer402 = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(402, { "content-type": "application/json", "x-seller": "one" });
  res.end(JSON.stringify({ x402Version: 1, accepts: [{ payTo: "Seller", network: "solana" }] }));
};

test("the connection goes to the pinned address, whatever the name resolves to", async () => {
  const seller = await listen(answer402);
  try {
    // `seller.invalid` never resolves (RFC 6761). The request arrives anyway:
    // the socket was opened to the pinned address and DNS was not asked.
    const response = await createPinnedFetch(LOOPBACK)(`http://seller.invalid:${seller.port}/probe?a=1`, {
      headers: { accept: "application/json" },
    });
    assert.equal(response.status, 402);
    assert.equal(response.headers.get("x-seller"), "one");
    assert.deepEqual(await response.json(), { x402Version: 1, accepts: [{ payTo: "Seller", network: "solana" }] });
    assert.equal(seller.seen.length, 1);
    assert.equal(seller.seen[0]!.host, `seller.invalid:${seller.port}`, "the Host header is the URL's own");
    assert.equal(seller.seen[0]!.url, "/probe?a=1");
    assert.equal(seller.seen[0]!.headers.accept, "application/json");
  } finally {
    await seller.close();
  }
});

test("a name is never resolved again: with nothing pinned there is nothing to connect to", async () => {
  const loopbackService = await listen(answer402);
  try {
    // `localhost` resolves to this listener for any ordinary fetch. The pinned
    // fetch was given no address for it, so it fails instead of looking it up.
    await assert.rejects(
      createPinnedFetch([])(`http://localhost:${loopbackService.port}/admin`),
      (error: NodeJS.ErrnoException) => error.code === "ENOTFOUND",
    );
    assert.equal(loopbackService.seen.length, 0, "the loopback service was never reached");
  } finally {
    await loopbackService.close();
  }
});

test("a redirect is returned, not followed", async () => {
  const target = await listen(answer402);
  const seller = await listen((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.port}/internal` });
    res.end();
  });
  try {
    const response = await createPinnedFetch(LOOPBACK)(`http://seller.invalid:${seller.port}/start`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `http://127.0.0.1:${target.port}/internal`);
    assert.equal(target.seen.length, 0);
  } finally {
    await seller.close();
    await target.close();
  }
});

test("an oversized body, an abort and a non-GET are failures, not hangs", async () => {
  const big = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.alloc(1024 * 1024 + 1));
  });
  const silent = await listen(() => { /* never answers */ });
  try {
    await assert.rejects(createPinnedFetch(LOOPBACK)(`http://seller.invalid:${big.port}/`), /limit/);
    await assert.rejects(
      createPinnedFetch(LOOPBACK)(`http://seller.invalid:${silent.port}/`, { signal: AbortSignal.timeout(100) }),
    );
    await assert.rejects(
      createPinnedFetch(LOOPBACK)(`http://seller.invalid:${big.port}/`, { method: "POST", body: "x" }),
      /GET or HEAD/,
    );
    await assert.rejects(createPinnedFetch(LOOPBACK)("ftp://seller.invalid/x"), /does not speak/);
  } finally {
    await big.close();
    await silent.close();
  }
});

test("pinnedLookup answers from its list for either calling convention", async () => {
  const lookup = pinnedLookup([
    { address: "93.184.216.34", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  const all = await new Promise((resolve) => lookup("x.example", { all: true }, (_e, addresses) => resolve(addresses)));
  assert.deepEqual(all, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  const one = await new Promise((resolve) =>
    lookup("x.example", { family: 6 }, (_e, address, family) => resolve([address, family])));
  assert.deepEqual(one, ["2606:4700:4700::1111", 6]);
  const none = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
    pinnedLookup([{ address: "93.184.216.34", family: 4 }])("x.example", { family: 6 }, (error) => resolve(error)));
  assert.equal(none?.code, "ENOTFOUND");
});
