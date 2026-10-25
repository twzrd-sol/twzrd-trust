import { createDemandDeskWallet, type DemandDeskWalletAdapter } from 'twzrd-x402-gate';
import type { Provider } from '@elizaos/core';

/** Host wallet provider for spend actions. Keep the raw adapter private; actions
 * receive only this facade. The intel-only plugin has no wallet to replace and
 * cannot intercept unrelated third-party plugins that retain their own keys. */
export function createDemandDeskWalletProvider<T>(adapter: DemandDeskWalletAdapter<T>) {
  const wallet = createDemandDeskWallet(adapter);
  return Object.freeze({
    name: 'TWZRD_DEMAND_DESK_WALLET',
    description: 'Guarded wallet capability for host spend actions under Demand Desk authorization.',
    get: (async () => ({
      text: 'Spend actions must use the configured Demand Desk wallet capability.',
      data: { wallet },
      values: { demandDeskWalletRequired: true },
    })) as Provider['get'],
    getWallet: () => wallet,
  });
}
