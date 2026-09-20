/** Report transport failures without dumping request headers, URLs or credentials. */
export function nodeErrorSummary(error) {
    const codes = new Set();
    const seen = new Set();
    const visit = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 4 || seen.has(value))
            return;
        seen.add(value);
        const e = value;
        if (typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(e.code))
            codes.add(e.code);
        visit(e.cause, depth + 1);
        if (Array.isArray(e.errors))
            e.errors.slice(0, 8).forEach(child => visit(child, depth + 1));
    };
    visit(error);
    if (codes.has('ECONNREFUSED'))
        return `${[...codes].join(', ')}: no server accepted the connection; check Lavalink host, port and container allocation.`;
    if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN'))
        return `${[...codes].join(', ')}: Lavalink hostname could not be resolved.`;
    if (codes.size)
        return `${[...codes].join(', ')}: check node reachability, TLS and the Lavalink server logs.`;
    // ws uses ordinary Error messages for HTTP upgrade failures, including bad passwords.
    const message = error instanceof Error ? error.message : '';
    const status = message.match(/Unexpected server response: (\d{3})\b/);
    if (status)
        return `WebSocket HTTP ${status[1]}: check Lavalink password, port, TLS and reverse-proxy WebSocket support.`;
    return 'Connection failed without a transport code; check Lavalink server logs, password and TLS settings.';
}
export function isLoopbackHost(host) {
    return /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(host.trim());
}
