#!/usr/bin/env node
// Production dependency audit for CI. Fails on any high or critical advisory except those allowlisted below.
//
// Allowlist (each entry needs a reason and a date; remove it once a patched release exists):
// - GHSA-3gc7-fjrx-p6mg (2026-10-12): bigint-buffer <=1.1.5 buffer overflow in toBigIntLE(). No patched bigint-buffer
//   release exists. Reached only through @solana/spl-token -> @solana/buffer-layout-utils, pulled in by x402-solana.
//   npm's suggested "fix" is downgrading twzrd-x402-gate to 0.8.10, which is not a fix.
// - GHSA-mrhx-c7xc-m3w5 (2026-10-24): zod <4.6.6 memory exhaustion on oversized constrained collections. The top-level
//   zod is patched (4.6.7); the remaining copies are zod 3.25.76, reachable only through @x402/core's zod ^3 dependency
//   (including x402-solana's nested @x402/core). No patched zod 3.x exists. Remove once @x402/core moves to zod 4.
import { execFileSync } from "node:child_process";

const DEFAULT_ALLOW = ["GHSA-3gc7-fjrx-p6mg", "GHSA-mrhx-c7xc-m3w5"];
const allow = new Set(
  process.env.AUDIT_ALLOWLIST === undefined ? DEFAULT_ALLOW : process.env.AUDIT_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean),
);

let raw;
try {
  raw = execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  raw = error.stdout; // npm audit exits non-zero when it finds anything; the JSON is still on stdout
}
const report = JSON.parse(raw);
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== "object" || !via.url) continue;
    const id = via.url.split("/").pop();
    advisories.set(id, { id, severity: via.severity, title: via.title, pkg: via.name });
  }
}
const blocking = [...advisories.values()].filter((a) => (a.severity === "high" || a.severity === "critical") && !allow.has(a.id));
const allowed = [...advisories.values()].filter((a) => allow.has(a.id));
for (const a of allowed) console.log(`allowlisted: ${a.id} (${a.severity}) ${a.pkg}: ${a.title}`);
if (blocking.length) {
  for (const a of blocking) console.error(`BLOCKING: ${a.id} (${a.severity}) ${a.pkg}: ${a.title}`);
  process.exit(1);
}
console.log(`audit ok: ${advisories.size} advisories, none high or critical outside the allowlist`);
