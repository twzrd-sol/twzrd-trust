#!/usr/bin/env node
/**
 * Publishable bin for twzrd-gate-doctor.
 * Prefers compiled dist; falls back to tsx source in dev checkouts.
 * Mirrors bin/twzrd-safe-fetch.js so packaging behaves identically.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist", "doctor.js");
const src = join(root, "src", "doctor.ts");

if (existsSync(dist)) {
  // Call main() explicitly rather than relying on doctor.js's own
  // argv[1]-sniffing auto-run guard: a dynamic import() here does not change
  // process.argv[1] (it stays this file's path, "twzrd-gate-doctor.js", which
  // does not match the guard's "ends in /doctor.js" regex), so the guard
  // never fires and the tool silently no-ops -- exit 0, zero output. That
  // shipped in 0.8.14 and was invisible in dev checkouts because the tsx
  // fallback branch below spawns src/doctor.ts as its own process, where
  // argv[1] genuinely does end in "doctor.ts" and the guard works by luck.
  const mod = await import(pathToFileURL(dist).href);
  process.exit(await mod.main());
} else if (existsSync(src)) {
  // Do NOT set cwd to the package root here (unlike twzrd-safe-fetch): the
  // doctor inspects process.cwd() to find the OPERATOR's package.json. Running
  // it from the package root made it read our own manifest and report a
  // signing surface for every project, including ones with nothing to gate.
  // tsx resolves `src` by absolute path, so the user's cwd is safe to keep.
  const r = spawnSync("npx", ["--yes", "tsx", src, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
} else {
  console.error(
    "twzrd-gate-doctor: missing dist/doctor.js — run npm run build in twzrd-x402-gate",
  );
  process.exit(1);
}
