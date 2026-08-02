import { RetryableError } from './retry.js';
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
/**
 * Parse a Response body as JSON, throwing a retryable error (502) if the
 * body is not valid JSON (e.g. an HTML error page from a proxy or a
 * maintenance page). This lets `withRetry` retry the request instead of
 * crashing with a raw `SyntaxError`.
 */
export async function safeParseJsonBody(resp, source) {
    try {
        return await resp.json();
    }
    catch (err) {
        throw new RetryableError(`${source} API returned non-JSON body (${err instanceof Error ? err.message : String(err)})`, 502);
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
    // Block IPv6 link-local (fe80::/10 — covers fe80:: through febf::)
    if (/^fe[89ab][0-9a-f]*:/i.test(hostname)) {
        throw new Error(`${label} blocked: ${hostname} is an IPv6 link-local address`);
    }
    // Block IPv4-mapped IPv6 link-local (::ffff:169.254.x.x)
    if (hostname.startsWith('::ffff:')) {
        const mappedIpv4 = hostname.slice(7);
        const ipv4Match = mappedIpv4.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
        if (ipv4Match && ipv4Match[1] === '169' && ipv4Match[2] === '254') {
            throw new Error(`${label} blocked: ${hostname} is an IPv4-mapped link-local address (cloud metadata endpoint)`);
        }
    }
    // Block AWS IPv6 metadata endpoint (fd00:ec2::254)
    if (hostname === 'fd00:ec2::254') {
        throw new Error(`${label} blocked: ${hostname} is an AWS metadata endpoint`);
    }
}
