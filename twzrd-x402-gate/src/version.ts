/**
 * Package version, stamped on the `X-TWZRD-Client` preflight attribution header.
 *
 * Single source of truth: package.json `version`. Never hand-edit a duplicate
 * string here — require the package root so src/ (tsx) and dist/ (published)
 * both resolve the same file one level up.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const CLIENT_VERSION: string = (
  require("../package.json") as { version: string }
).version;
