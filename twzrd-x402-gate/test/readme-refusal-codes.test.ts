/**
 * The README "Refusals" section must name every reason string the gate can
 * return. Reasons are extracted from the source (not from a hand list), so a
 * new refusal that is not documented fails here.
 * Run: npx tsx test/readme-refusal-codes.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const SOURCES = [
  "src/policy.ts",
  "src/merchant-card.ts",
  "src/network.ts",
  "src/payto.ts",
  "src/x402-client-hook.ts",
  "src/guarded-x402-fetch.ts",
  "src/spend-control.ts",
];

// Classification labels that share the `reason` field but never refuse.
const NOT_REFUSALS = new Set(["solana_scored", "base_scored"]);

/** Strip // and /* *\/ comments so prose mentions of old codes do not count. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Leading identifier of a reason literal: `twzrd_decision_${x}` -> `twzrd_decision_`. */
function head(literal: string): string | undefined {
  const m = literal.replace(/^\[twzrd[a-z-]*\] /, "").match(/^[a-z][a-zA-Z0-9_]*/);
  return m ? m[0] : undefined;
}

const found = new Map<string, string>();
for (const rel of SOURCES) {
  const src = code(read(rel));
  const patterns = [
    /\breason\s*[:=]\s*(["`])((?:\[twzrd[a-z-]*\] )?[a-z][^"`]*)\1?/g,
    /\breason\s*=\s*\n\s*(["`])((?:\[twzrd[a-z-]*\] )?[a-z][^"`]*)/g,
    /\babort\(\s*(["`])([a-z][a-z0-9_]*)/g,
    /_FIELD_CONFLICT\s*=\s*(["'`])([a-z_]+)/g,
    // Any twzrd_* string literal in code: helper calls (refuse(`...`)) and ternaries.
    /(["`])((?:\[twzrd[a-z-]*\] )?twzrd_[a-zA-Z0-9_]*)/g,
    /\breason\s*:\s*[^,\n]*?\?\s*(["`])([a-z][a-z0-9_]*)/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const h = head(m[2]);
      if (h && !NOT_REFUSALS.has(h)) found.set(h, rel);
    }
  }
}

const readme = read("README.md");
const start = readme.indexOf("\n## Refusals\n");
assert.ok(start >= 0, "README has a ## Refusals section");
const end = readme.indexOf("\n## ", start + 5);
const section = readme.slice(start, end < 0 ? undefined : end);

// Sanity: the extractor must see the codes this test exists for.
for (const must of [
  "twzrd_non_usdc_asset",
  "twzrd_decision_",
  "twzrd_unevaluated_over_cap_",
  "twzrd_fail_closed",
  "twzrd_card_unreachable_fail_closed",
  "price_cap_exceeded",
  "non_usdc_asset",
  "amount_field_conflict",
]) {
  assert.ok(found.has(must), `extractor missed ${must}; found ${[...found.keys()].join(", ")}`);
}
for (const label of NOT_REFUSALS) {
  assert.ok(SOURCES.some((rel) => read(rel).includes(`"${label}"`)), `stale NOT_REFUSALS entry ${label}`);
}

const missing = [...found.entries()].filter(([h]) => !section.includes(h));
assert.deepEqual(
  missing,
  [],
  `README ## Refusals is missing: ${missing.map(([h, rel]) => `${h} (${rel})`).join(", ")}`,
);

console.log(`readme-refusal-codes.test.ts: ALL PASSED (${found.size} reasons documented)`);
