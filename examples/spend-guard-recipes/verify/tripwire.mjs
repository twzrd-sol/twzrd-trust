// Test-only preload: refuse every fetch that is not to loopback, and record it.
// Used as: node --import <this file> ...  (TRIPWIRE_LOG names an append-only log file)
import { appendFileSync } from "node:fs";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const realFetch = globalThis.fetch;
globalThis.__tripwireHits = [];
globalThis.fetch = async function tripwireFetch(input, init) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!LOOPBACK.has(url.hostname)) {
    globalThis.__tripwireHits.push(url.href);
    if (process.env.TRIPWIRE_LOG) appendFileSync(process.env.TRIPWIRE_LOG, url.href + "\n");
    throw new Error("tripwire: non-loopback fetch refused: " + url.origin);
  }
  return realFetch(input, init);
};
