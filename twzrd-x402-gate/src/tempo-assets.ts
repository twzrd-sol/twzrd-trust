/**
 * Tempo chain ids the MPP guard accepts, and the USD TIP-20 tokens it accepts on
 * each. Shared by mpp-hook.ts (which refuses any other currency before mppx
 * creates a credential) and intelligence.ts (which leaves an already-checked
 * Tempo asset out of the x402 USDC-table rule).
 */
export const TEMPO_USD_ASSETS: Readonly<Record<number, ReadonlySet<string>>> = {
  // mppx 0.17's default Tempo charge offers (OUSD, USDC.e) on mainnet and
  // (OUSD, pathUSD) on Moderato. pathUSD is also deployed on mainnet.
  4217: new Set([
    "0x20c0000000000000000000006a37da5c996874be", // OUSD
    "0x20c000000000000000000000b9537d11c60e8b50", // USDC.e
    "0x20c0000000000000000000000000000000000000", // pathUSD
  ]),
  42431: new Set([
    "0x20c0000000000000000000006a37da5c996874be", // OUSD
    "0x20c0000000000000000000000000000000000000", // pathUSD
  ]),
};

/** True when `network` is a Tempo `eip155:<id>` and `asset` is on that chain's USD list. */
export function isTempoUsdAsset(network: unknown, asset: unknown): boolean {
  const m = /^eip155:(\d+)$/.exec(String(network ?? "").trim());
  if (!m || typeof asset !== "string") return false;
  return TEMPO_USD_ASSETS[Number(m[1])]?.has(asset.trim().toLowerCase()) ?? false;
}
