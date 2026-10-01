const PUBLIC_CLUSTER_HOSTS = new Set([
    'api.mainnet-beta.solana.com',
    'api.devnet.solana.com',
    'api.testnet.solana.com',
]);
export function privateRpcUrl(value) {
    const candidate = value?.trim();
    if (!candidate)
        return '';
    try {
        const url = new URL(candidate);
        if (!['http:', 'https:'].includes(url.protocol))
            return '';
        if (PUBLIC_CLUSTER_HOSTS.has(url.hostname.replace(/\.+$/, '')))
            return '';
        if (decodeURIComponent(url.pathname).toLowerCase().split('/').includes('public'))
            return '';
        return candidate;
    }
    catch {
        return '';
    }
}
