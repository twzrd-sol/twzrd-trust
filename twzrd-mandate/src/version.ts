import { createRequire } from "node:module";

/** This package's version, read from its own package.json. */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
