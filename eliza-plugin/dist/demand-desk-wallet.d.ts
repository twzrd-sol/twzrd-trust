import { type DemandDeskWalletAdapter } from 'twzrd-x402-gate';
import type { Provider } from '@elizaos/core';
/** Host wallet provider for spend actions. Keep the raw adapter private; actions
 * receive only this facade. The intel-only plugin has no wallet to replace and
 * cannot intercept unrelated third-party plugins that retain their own keys. */
export declare function createDemandDeskWalletProvider<T>(adapter: DemandDeskWalletAdapter<T>): Readonly<{
    name: "TWZRD_DEMAND_DESK_WALLET";
    description: "Guarded wallet capability for host spend actions under Demand Desk authorization.";
    get: Provider["get"];
    getWallet: () => Readonly<{
        signTransaction: (tx: T, context: import("twzrd-x402-gate").DemandDeskWalletContext) => Promise<T>;
        signAllTransactions(items: readonly {
            transaction: T;
            context: import("twzrd-x402-gate").DemandDeskWalletContext;
        }[]): Promise<T[]>;
        signAndSendTransaction(tx: T, context: import("twzrd-x402-gate").DemandDeskWalletContext): Promise<string>;
    }>;
}>;
