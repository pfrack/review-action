export function safeParseJson(content) {
    const trimmed = content.trim();
    if (!trimmed)
        return undefined;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
}
export function escapeMarkdown(text) {
    return text.replace(/[\\*_{}\[\]()#`>+~|!<&]/g, '\\$&');
}
export function validateProviderUrl(url, label) {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    // Block known metadata hostnames
    if (hostname === 'metadata.google.internal') {
        throw new Error(`${label} blocked: metadata.google.internal is a cloud metadata endpoint`);
    }
    // Block IPv4 link-local (169.254.0.0/16 — covers AWS/Azure metadata at 169.254.169.254)
    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
    if (ipv4Match && ipv4Match[1] === '169' && ipv4Match[2] === '254') {
        throw new Error(`${label} blocked: ${hostname} is a link-local address (cloud metadata endpoint)`);
    }
    // Block IPv6 link-local (fe80::/10)
    if (hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) {
        throw new Error(`${label} blocked: ${hostname} is an IPv6 link-local address`);
    }
    // Block AWS IPv6 metadata endpoint (fd00:ec2::254)
    if (hostname === 'fd00:ec2::254' || hostname === '[fd00:ec2::254]') {
        throw new Error(`${label} blocked: ${hostname} is an AWS metadata endpoint`);
    }
}
