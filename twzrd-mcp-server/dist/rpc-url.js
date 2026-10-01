export function privateRpcUrl(value) {
    const candidate = value?.trim();
    if (!candidate)
        return '';
    try {
        const url = new URL(candidate);
        if (!['http:', 'https:'].includes(url.protocol)
            || ['api.mainnet-beta.solana.com', 'api.devnet.solana.com', 'api.testnet.solana.com'].includes(url.hostname)
            || /\/public(?:\/|$)/.test(url.pathname))
            return '';
        return candidate;
    }
    catch {
        return '';
    }
}
