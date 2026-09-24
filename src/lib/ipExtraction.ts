import type { IncomingMessage } from 'node:http';

export interface ClientIpOptions {
  /**
   * Explicit set or array of trusted proxy IP addresses.
   * If the immediate remoteAddress is not in this set, forwarding headers are ignored.
   */
  trustedProxies?: string[] | Set<string>;

  /**
   * Explicit count of trusted reverse proxy hops.
   * For N trusted proxies, extracts the N-th IP from the right of X-Forwarded-For.
   */
  trustedProxyCount?: number;

  /**
   * Master toggle for trusting proxy headers.
   * If false, forwarding headers are always ignored. Defaults to true.
   */
  trustProxy?: boolean;
}

/**
 * Normalizes an IP string by stripping IPv4-mapped IPv6 prefixes (::ffff:) and trimming whitespace.
 */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice(7);
  }
  return trimmed;
}

/**
 * Parses a comma-separated list of IP addresses into a Set of normalized and raw IP strings.
 */
export function parseTrustedProxies(raw?: string): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed) {
      set.add(trimmed);
      set.add(normalizeIp(trimmed));
    }
  }
  return set;
}

/**
 * Checks if an IP address matches the trusted proxies set (accounting for IPv4-mapped IPv6).
 */
export function isTrustedProxy(ip: string, trustedProxies: Set<string>): boolean {
  if (trustedProxies.size === 0) return false;
  return trustedProxies.has(ip) || trustedProxies.has(normalizeIp(ip));
}

/**
 * Extracts the client IP address from the request, respecting X-Forwarded-For
 * only from explicitly trusted proxy positions.
 *
 * Extraction Rules:
 * 1. If trustProxy is disabled (or RATE_LIMIT_TRUST_PROXY='false') or neither trustedProxyCount
 *    nor trustedProxies are configured, the direct socket remoteAddress is returned.
 * 2. When trustedProxyCount (N > 0) is configured:
 *    - If trustedProxies is also configured, the direct socket remoteAddress must
 *      be in trustedProxies; otherwise remoteAddress is returned.
 *    - The N-th IP from the right of the X-Forwarded-For header is extracted (representing
 *      the client IP added by the outermost trusted reverse proxy).
 *    - Any forwarding entries beyond the trusted hop count are ignored, preventing
 *      upstream clients from spoofing their address by prepending headers.
 * 3. When trustedProxies is configured without a specific hop count:
 *    - If the direct socket remoteAddress is not in trustedProxies, remoteAddress is returned.
 *    - X-Forwarded-For is traversed from right to left (from most recent proxy to oldest).
 *    - The first IP encountered that is NOT in trustedProxies is returned as the client IP.
 *    - Any headers prepended before that point cannot spoof the client IP.
 *
 * Canonical IP extraction function used across the application (rate limiting, auth lockout,
 * websocket connection limiting, and audit logging).
 */
export function getClientIp(req: IncomingMessage, options?: ClientIpOptions): string {
  const remoteAddress = req.socket?.remoteAddress || (req as { ip?: string }).ip || 'unknown';
  if (remoteAddress === 'unknown') {
    return 'unknown';
  }

  let trustProxy =
    options?.trustProxy ?? (process.env.RATE_LIMIT_TRUST_PROXY !== 'false');

  // Check Express app-level trust proxy setting if present
  const expressTrustProxy = (req as { app?: { get?: (k: string) => unknown } }).app?.get?.(
    'trust proxy'
  );
  if (expressTrustProxy === false && options?.trustProxy === undefined) {
    trustProxy = false;
  }

  if (!trustProxy) {
    return remoteAddress;
  }

  const rawForwarded = req.headers['x-forwarded-for'];
  if (!rawForwarded) {
    return remoteAddress;
  }

  // Parse trusted proxy addresses
  let trustedProxies: Set<string>;
  if (options?.trustedProxies) {
    trustedProxies =
      options.trustedProxies instanceof Set
        ? options.trustedProxies
        : parseTrustedProxies(options.trustedProxies.join(','));
  } else {
    const envProxies =
      process.env.TRUSTED_PROXIES ||
      process.env.WS_TRUSTED_PROXIES ||
      process.env.RATE_LIMIT_TRUSTED_PROXIES ||
      '';
    trustedProxies = parseTrustedProxies(envProxies);

    // If no env proxies, check Express app configuration
    if (trustedProxies.size === 0 && expressTrustProxy) {
      if (Array.isArray(expressTrustProxy)) {
        trustedProxies = parseTrustedProxies(expressTrustProxy.join(','));
      } else if (typeof expressTrustProxy === 'string' && Number.isNaN(Number(expressTrustProxy))) {
        trustedProxies = parseTrustedProxies(expressTrustProxy);
      }
    }
  }

  // Parse trusted proxy count / hops
  let trustedProxyCount =
    options?.trustedProxyCount ??
    parseInt(
      process.env.TRUSTED_PROXY_COUNT ||
        process.env.TRUST_PROXY_HOPS ||
        process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT ||
        '0',
      10
    );

  if (Number.isNaN(trustedProxyCount) || trustedProxyCount < 0) {
    trustedProxyCount = 0;
  }

  // If no env hop count, check Express app configuration
  if (trustedProxyCount === 0 && expressTrustProxy && trustedProxies.size === 0) {
    if (typeof expressTrustProxy === 'number') {
      trustedProxyCount = expressTrustProxy;
    } else if (expressTrustProxy === true) {
      trustedProxyCount = 1;
    } else if (typeof expressTrustProxy === 'string' && !Number.isNaN(Number(expressTrustProxy))) {
      trustedProxyCount = parseInt(expressTrustProxy, 10);
    }
  }

  // If neither hop count nor trusted proxy list is configured, do not trust forwarding headers
  if (trustedProxyCount <= 0 && trustedProxies.size === 0) {
    return remoteAddress;
  }

  // Parse X-Forwarded-For entries into array of non-empty trimmed IPs
  const ips = (Array.isArray(rawForwarded) ? rawForwarded.join(',') : rawForwarded)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (ips.length === 0) {
    return remoteAddress;
  }

  // If trustedProxyCount > 0 is configured
  if (trustedProxyCount > 0) {
    // If trustedProxies is also specified, verify that the immediate peer is trusted
    if (trustedProxies.size > 0 && !isTrustedProxy(remoteAddress, trustedProxies)) {
      return remoteAddress;
    }

    // Extract the N-th hop from the right
    const targetIndex = ips.length - trustedProxyCount;
    if (targetIndex >= 0) {
      return ips[targetIndex];
    }
    // If fewer hops exist than configured, take the furthest upstream available
    return ips[0];
  }

  // If only trustedProxies address list is configured
  if (trustedProxies.size > 0) {
    // Verify immediate peer is a trusted proxy
    if (!isTrustedProxy(remoteAddress, trustedProxies)) {
      return remoteAddress;
    }

    // Traverse from right to left (most recent proxy to oldest)
    for (let i = ips.length - 1; i >= 0; i--) {
      const candidate = ips[i];
      if (!isTrustedProxy(candidate, trustedProxies)) {
        return candidate;
      }
    }

    // If all hops are trusted proxies, return the furthest upstream IP
    return ips[0];
  }

  return remoteAddress;
}
