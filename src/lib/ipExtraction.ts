import type { IncomingMessage } from 'node:http';

/**
 * Extracts the client IP address from the request, respecting X-Forwarded-For
 * only if the remote address is a trusted proxy.
 *
 * Canonical IP extraction function used by rate limiting, connection limiting,
 * and banning. No other module should duplicate this logic.
 */
export function getClientIp(req: IncomingMessage): string {
  const expressIp = (req as { ip?: string }).ip;
  if (expressIp) return expressIp;
  const remoteAddress = req.socket.remoteAddress || 'unknown';
  const xForwardedFor = req.headers['x-forwarded-for'];
  const trustedProxies = new Set(
    (process.env.WS_TRUSTED_PROXIES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  if (xForwardedFor && trustedProxies.has(remoteAddress)) {
    const ips = (Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor)
      .split(',')
      .map((s) => s.trim());
    return ips[0] || remoteAddress;
  }

  return remoteAddress;
}
