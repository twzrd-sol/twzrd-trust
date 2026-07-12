#!/usr/bin/env node
/**
 * Publishable bin for twzrd-safe-fetch.
 * Prefers compiled dist; falls back to tsx source in dev checkouts.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist", "safe-fetch.js");
const src = join(root, "src", "safe-fetch.ts");

if (existsSync(dist)) {
  await import(pathToFileURL(dist).href);
} else if (existsSync(src)) {
  const r = spawnSync(
    "npx",
    ["--yes", "tsx", src, ...process.argv.slice(2)],
    { stdio: "inherit", cwd: root },
  );
  process.exit(r.status ?? 1);
} else {
  console.error(
    "twzrd-safe-fetch: missing dist/safe-fetch.js — run npm run build in twzrd-x402-gate",
  );
  process.exit(1);
}
