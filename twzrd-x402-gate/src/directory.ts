/**
 * Thin directory client — trust sits beside discovery, not inside it.
 *
 * GET /v1/intel/resources (source of truth) and GET /v1/intel/x402-directory
 * (multi-bazaar overlay). No ranking, no local cache, no TWZRD-owned catalog.
 * Callers pick a callable, then preflight the payTo.
 */

export type DirectorySource = "resources" | "x402-directory";

export type DirectoryListing = {
  resourceUrl: string | null;
  payTo: string | null;
  live402: boolean | null;
  listed: boolean | null;
  name: string | null;
  source: DirectorySource;
};

export type ListDirectoryOptions = {
  intelBase?: string;
  fetch?: typeof fetch;
  limit?: number;
  live402Only?: boolean;
};

const DEFAULT_INTEL = "https://intel.twzrd.xyz";

function intelBase(opts?: ListDirectoryOptions): string {
  return (opts?.intelBase ?? process.env.TWZRD_INTEL_BASE ?? DEFAULT_INTEL).replace(/\/+$/, "");
}

function asRecords(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  }
  if (!body || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  for (const key of ["resources", "items", "results", "data", "listings"]) {
    const v = obj[key];
    if (Array.isArray(v)) {
      return v.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
    }
  }
  return [];
}

function str(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function flag(row: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "boolean") return v;
  }
  return null;
}

export function normalizeDirectoryRow(
  row: Record<string, unknown>,
  source: DirectorySource,
): DirectoryListing {
  const nested =
    row.resource && typeof row.resource === "object"
      ? (row.resource as Record<string, unknown>)
      : {};
  return {
    resourceUrl:
      str(row, "resource_url", "resourceUrl", "url", "endpoint") ??
      str(nested, "url", "resource_url"),
    payTo:
      str(row, "pay_to", "payTo", "seller_wallet", "sellerWallet") ??
      str(nested, "pay_to", "payTo"),
    live402: flag(row, "live_402", "live402"),
    listed: flag(row, "listed"),
    name: str(row, "name", "resource_name", "title") ?? str(nested, "name"),
    source,
  };
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const resp = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!resp.ok) {
    throw new Error(`[twzrd-x402-gate] directory HTTP ${resp.status} for ${url}`);
  }
  return resp.json();
}

/** Resource join — source of truth for listed | live_402 callables. */
export async function listResources(
  opts: ListDirectoryOptions = {},
): Promise<DirectoryListing[]> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const limit = opts.limit ?? 20;
  const live = opts.live402Only === true ? "&live_402_only=true" : "";
  const body = await getJson(
    `${intelBase(opts)}/v1/intel/resources?limit=${limit}${live}`,
    fetchImpl,
  );
  return asRecords(body).map((row) => normalizeDirectoryRow(row, "resources"));
}

/** Multi-bazaar overlay. Does not rank; TWZRD only enriches pay_to. */
export async function listX402Directory(
  opts: ListDirectoryOptions = {},
): Promise<DirectoryListing[]> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const limit = opts.limit ?? 20;
  const body = await getJson(
    `${intelBase(opts)}/v1/intel/x402-directory?limit=${limit}`,
    fetchImpl,
  );
  return asRecords(body).map((row) => normalizeDirectoryRow(row, "x402-directory"));
}

/**
 * First usable callable: prefer a live_402 row with payTo, else any row with payTo.
 * No ranking by volume, wash, or score.
 */
export function pickCallable(listings: DirectoryListing[]): DirectoryListing | null {
  const withPayTo = listings.filter((row) => row.payTo);
  return withPayTo.find((row) => row.live402 === true) ?? withPayTo[0] ?? null;
}

/** List resource-join first, fall back to the bazaar overlay if empty. */
export async function listDirectoryCallables(
  opts: ListDirectoryOptions = {},
): Promise<DirectoryListing[]> {
  const resources = await listResources(opts);
  if (resources.length > 0) return resources;
  return listX402Directory(opts);
}
