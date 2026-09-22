import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** House dogfood wallets. A Path A "foreign" pay must not load these. */
export const HOUSE_PAYER_PREFIXES = [
  "/home/twzrd/security/wallets/x402-reader/",
  "/home/twzrd/security/wallets/outbid/",
  "/home/twzrd/security/wallets/outbid-token/",
] as const;

export class HousePayerKeyError extends Error {
  override name = "HousePayerKeyError";
  constructor(resolved: string) {
    super(`[twzrd] house payer key refused: ${resolved}`);
  }
}

export class ForeignPayerInputError extends Error {
  override name = "ForeignPayerInputError";
  constructor(message: string) {
    super(`[twzrd] ${message}`);
  }
}

export function assertNotHousePayerKey(absPath: string): void {
  let resolved: string;
  try {
    resolved = realpathSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    resolved = resolve(absPath);
  }
  for (const prefix of HOUSE_PAYER_PREFIXES) {
    if (resolved === prefix.slice(0, -1) || resolved.startsWith(prefix)) {
      throw new HousePayerKeyError(resolved);
    }
  }
}

export function requireForeignPayerInput(
  env: NodeJS.ProcessEnv,
  argv: string[],
): { keyPath: string; maxUsd: string; dailyUsd: string; url: string } {
  const keyPath = String(env.PAYER_SVM_KEY || "");
  const maxUsd = String(env.MAX_USD || "");
  const dailyUsd = String(env.DAILY_USD || "");
  const url = String(argv.find((a) => !a.startsWith("-")) || "");
  if (!keyPath || !maxUsd || !dailyUsd || !url) {
    throw new ForeignPayerInputError("need PAYER_SVM_KEY MAX_USD DAILY_USD and a https URL");
  }
  return { keyPath, maxUsd, dailyUsd, url };
}

export function assertHttpsTarget(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ForeignPayerInputError("url");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.protocol !== "https:" || host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new ForeignPayerInputError("url must be https and not loopback");
  }
  return u;
}
