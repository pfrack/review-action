import { RetryableError } from './retry.js';

export function safeParseJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Parse a Response body as JSON, throwing a retryable error (502) if the
 * body is not valid JSON (e.g. an HTML error page from a proxy or a
 * maintenance page). This lets `withRetry` retry the request instead of
 * crashing with a raw `SyntaxError`.
 */
export async function safeParseJsonBody(resp: Response, source: string): Promise<unknown> {
  try {
    return await resp.json();
  } catch (err) {
    throw new RetryableError(
      `${source} API returned non-JSON body (${err instanceof Error ? err.message : String(err)})`,
      502,
    );
  }
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_{}\[\]()#`>+~|!<&]/g, '\\$&');
}

export function validateProviderUrl(url: string, label: string): void {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  const isLoopback =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0';

  // Loopback is permitted for local development and tests (incl. http).
  // Every other endpoint must be https so the provider API key is not sent
  // in plaintext.
  if (!isLoopback && parsed.protocol !== 'https:') {
    throw new Error(`${label} blocked: only https URLs are allowed (received ${parsed.protocol || 'unknown'})`);
  }

  // Block known metadata hostnames
  if (hostname === 'metadata.google.internal') {
    throw new Error(`${label} blocked: metadata.google.internal is a cloud metadata endpoint`);
  }

  // Block IPv4 link-local (169.254.0.0/16 — covers AWS/Azure metadata at 169.254.169.254)
  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ipv4Match) {
    const [octet1, octet2] = ipv4Match.slice(1, 3).map(Number);
    if (octet1 === 169 && octet2 === 254) {
      throw new Error(`${label} blocked: ${hostname} is a link-local address (cloud metadata endpoint)`);
    }
    // Block private RFC1918 ranges (10/8, 172.16/12, 192.168/16) — the key
    // exfiltration vector if a workflow input points at an internal endpoint.
    if (octet1 === 10) {
      throw new Error(`${label} blocked: ${hostname} is a private network address`);
    }
    if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) {
      throw new Error(`${label} blocked: ${hostname} is a private network address`);
    }
    if (octet1 === 192 && octet2 === 168) {
      throw new Error(`${label} blocked: ${hostname} is a private network address`);
    }
  }

  // Block IPv6 link-local (fe80::/10 — covers fe80:: through febf::)
  if (/^fe[89ab][0-9a-f]*:/i.test(hostname)) {
    throw new Error(`${label} blocked: ${hostname} is an IPv6 link-local address`);
  }

  // Block IPv4-mapped IPv6 link-local (::ffff:169.254.x.x)
  if (hostname.startsWith('::ffff:')) {
    const mappedIpv4 = hostname.slice(7);
    const mappedMatch = mappedIpv4.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
    if (mappedMatch && mappedMatch[1] === '169' && mappedMatch[2] === '254') {
      throw new Error(`${label} blocked: ${hostname} is an IPv4-mapped link-local address (cloud metadata endpoint)`);
    }
  }

  // Block AWS IPv6 metadata endpoint (fd00:ec2::254)
  if (hostname === 'fd00:ec2::254') {
    throw new Error(`${label} blocked: ${hostname} is an AWS metadata endpoint`);
  }
}
