/**
 * Pure. No network — every DNS lookup is injected.
 * Run: npx tsx --test test/ssrf.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { hasForbiddenResolution, isBlockedIpAddress } from "../src/ssrf.js";

test("isBlockedIpAddress covers private, loopback, link-local, and CGNAT ranges", () => {
  for (const addr of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.5",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isBlockedIpAddress(addr), true, addr);
  }
  for (const addr of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedIpAddress(addr), false, addr);
  }
  assert.equal(isBlockedIpAddress("not-an-ip"), true);
});

test("hasForbiddenResolution blocks a literal private IP with no DNS lookup", async () => {
  let calls = 0;
  const resolve = async () => {
    calls += 1;
    return [];
  };
  assert.equal(await hasForbiddenResolution("https://169.254.169.254/latest/meta-data", resolve), true);
  assert.equal(await hasForbiddenResolution("https://[::1]/", resolve), true);
  assert.equal(calls, 0, "literal IPs never reach the resolver");
});

test("hasForbiddenResolution blocks decimal, hex, and bare metadata-style hostnames", async () => {
  const resolve = async () => {
    throw new Error("must not be called for weird encodings");
  };
  assert.equal(await hasForbiddenResolution("https://2130706433/", resolve), true);
  assert.equal(await hasForbiddenResolution("https://0x7f000001/", resolve), true);
  assert.equal(await hasForbiddenResolution("https://metadata.google.internal/", resolve), true);
  assert.equal(await hasForbiddenResolution("https://foo.internal/", resolve), true);
});

test("hasForbiddenResolution blocks a public hostname that resolves to a private address", async () => {
  const resolve = async (host: string) => {
    assert.equal(host, "rebinder.example");
    return [{ address: "10.0.0.5", family: 4 }];
  };
  assert.equal(await hasForbiddenResolution("https://rebinder.example/x", resolve), true);
});

test("hasForbiddenResolution allows a public hostname resolving only to public addresses", async () => {
  const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
  assert.equal(await hasForbiddenResolution("https://seller.example/x", resolve), false);
});

test("hasForbiddenResolution fails closed on a DNS lookup error or empty result", async () => {
  assert.equal(
    await hasForbiddenResolution("https://nxdomain.example/", async () => {
      throw new Error("ENOTFOUND");
    }),
    true,
  );
  assert.equal(
    await hasForbiddenResolution("https://no-records.example/", async () => []),
    true,
  );
});

test("hasForbiddenResolution fails closed on an unparsable URL", async () => {
  assert.equal(await hasForbiddenResolution("not a url", async () => []), true);
});

test("hasForbiddenResolution blocks when only one of several resolved addresses is private", async () => {
  const resolve = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ];
  assert.equal(await hasForbiddenResolution("https://multi-homed.example/", resolve), true);
});
