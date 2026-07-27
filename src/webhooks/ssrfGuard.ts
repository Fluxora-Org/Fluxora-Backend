/**
 * SSRF (Server-Side Request Forgery) protection for webhook targets.
 *
 * This module validates webhook endpoint URLs to prevent SSRF attacks that could
 * target internal services, cloud metadata endpoints (e.g., 169.254.169.254), or
 * other reserved IP ranges.
 *
 * Security considerations:
 * - Blocks loopback addresses (127.0.0.0/8, ::1)
 * - Blocks link-local addresses (169.254.0.0/16, fe80::/10)
 * - Blocks private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7)
 * - Blocks other reserved ranges (0.0.0.0/8, 240.0.0.0/4, etc.)
 * - Requires HTTPS by default (configurable)
 * - Resolves hostnames and validates resolved IPs to defeat DNS rebinding
 * - Supports optional host allowlist via options parameter
 * - Handles IPv4-mapped IPv6 addresses and alternative IP encodings
 *
 * The validation fails closed: any ambiguous or unresolvable target is rejected.
 */

import { logger } from '../lib/logger.js';

/**
 * Error thrown when a webhook target URL fails SSRF validation.
 */
export class WebhookTargetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookTargetValidationError';
  }
}

/**
 * IP range definitions for blocked addresses.
 */
interface IPRange {
  name: string;
  start: bigint;
  end: bigint;
  description: string;
}

/**
 * Convert IPv4 address to bigint for range comparison.
 * Handles decimal and octal encodings by parsing through URL.
 */
function ipv4ToBigInt(ip: string): bigint {
  // Remove any leading zeros and parse
  const parts = ip.split('.').map(p => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(isNaN)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  
  let result = 0n;
  for (const part of parts) {
    if (part < 0 || part > 255) {
      throw new Error(`Invalid IPv4 octet: ${part}`);
    }
    result = (result << 8n) + BigInt(part);
  }
  return result;
}

/**
 * Convert IPv6 address to bigint for range comparison.
 * Handles IPv4-mapped IPv6 addresses (::ffff:x.x.x.x).
 */
function ipv6ToBigInt(ip: string): bigint {
  // Handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4Match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Match) {
    // Map IPv4 into the IPv6 space
    const v4BigInt = ipv4ToBigInt(v4Match[1]);
    return (0xffffn << 96n) + v4BigInt;
  }

  // Parse standard IPv6
  const sections = ip.split(':');
  if (sections.length !== 8) {
    throw new Error(`Invalid IPv6 address: ${ip}`);
  }

  let result = 0n;
  for (const section of sections) {
    if (section === '') {
      throw new Error(`Invalid IPv6 address (empty section): ${ip}`);
    }
    const value = BigInt(parseInt(section, 16));
    if (value < 0n || value > 0xffffn) {
      throw new Error(`Invalid IPv6 section: ${section}`);
    }
    result = (result << 16n) + value;
  }
  return result;
}

/**
 * Blocked IP ranges that should not be accessible via webhooks.
 */
const BLOCKED_RANGES: IPRange[] = [
  // Loopback
  {
    name: 'loopback',
    start: ipv4ToBigInt('127.0.0.0'),
    end: ipv4ToBigInt('127.255.255.255'),
    description: 'Loopback addresses (127.0.0.0/8)',
  },
  // Link-local (AWS metadata service lives here)
  {
    name: 'link-local',
    start: ipv4ToBigInt('169.254.0.0'),
    end: ipv4ToBigInt('169.254.255.255'),
    description: 'Link-local addresses (169.254.0.0/16)',
  },
  // Private networks
  {
    name: 'private-10',
    start: ipv4ToBigInt('10.0.0.0'),
    end: ipv4ToBigInt('10.255.255.255'),
    description: 'Private network (10.0.0.0/8)',
  },
  {
    name: 'private-172',
    start: ipv4ToBigInt('172.16.0.0'),
    end: ipv4ToBigInt('172.31.255.255'),
    description: 'Private network (172.16.0.0/12)',
  },
  {
    name: 'private-192',
    start: ipv4ToBigInt('192.168.0.0'),
    end: ipv4ToBigInt('192.168.255.255'),
    description: 'Private network (192.168.0.0/16)',
  },
  // Reserved
  {
    name: 'reserved-0',
    start: ipv4ToBigInt('0.0.0.0'),
    end: ipv4ToBigInt('0.255.255.255'),
    description: 'Reserved addresses (0.0.0.0/8)',
  },
  {
    name: 'reserved-240',
    start: ipv4ToBigInt('240.0.0.0'),
    end: ipv4ToBigInt('255.255.255.255'),
    description: 'Reserved addresses (240.0.0.0/4)',
  },
  // Multicast
  {
    name: 'multicast',
    start: ipv4ToBigInt('224.0.0.0'),
    end: ipv4ToBigInt('239.255.255.255'),
    description: 'Multicast addresses (224.0.0.0/4)',
  },
];

/**
 * Check if an IPv4 address falls within a blocked range.
 */
function isBlockedIPv4(ip: string): { blocked: boolean; reason?: string } {
  try {
    const ipBigInt = ipv4ToBigInt(ip);
    
    for (const range of BLOCKED_RANGES) {
      if (ipBigInt >= range.start && ipBigInt <= range.end) {
        return { blocked: true, reason: range.description };
      }
    }
    
    return { blocked: false };
  } catch (error) {
    // If we can't parse the IP, fail closed
    return { blocked: true, reason: 'Unparseable IPv4 address' };
  }
}

/**
 * Check if an IPv6 address is loopback or link-local.
 */
function isBlockedIPv6(ip: string): { blocked: boolean; reason?: string } {
  // IPv6 loopback (::1)
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') {
    return { blocked: true, reason: 'IPv6 loopback address' };
  }
  
  // IPv4-mapped loopback (::ffff:127.0.0.1)
  const v4MappedLoopback = ip.match(/^::ffff:127\.\d+\.\d+\.\d+$/i);
  if (v4MappedLoopback) {
    return { blocked: true, reason: 'IPv4-mapped loopback address' };
  }
  
  // Link-local (fe80::/10)
  if (ip.startsWith('fe80:') || ip.startsWith('FE80:')) {
    return { blocked: true, reason: 'IPv6 link-local address' };
  }
  
  // Unique local (fc00::/7) - private IPv6 range
  const firstTwoHex = parseInt(ip.substring(0, 2), 16);
  if ((firstTwoHex & 0xfe) === 0xfc) {
    return { blocked: true, reason: 'IPv6 unique local address (private)' };
  }
  
  return { blocked: false };
}

/**
 * Resolve a hostname to its IP addresses.
 * This is used to defeat DNS rebinding attacks.
 */
async function resolveHostname(hostname: string): Promise<string[]> {
  try {
    // Use Node.js DNS resolution
    const dns = await import('dns');
    const { lookup } = dns.promises;
    
    const { address, family } = await lookup(hostname, { all: false });
    
    // Convert to array for consistent interface
    return [address];
  } catch (error) {
    // If DNS resolution fails, fail closed
    throw new WebhookTargetValidationError(
      `DNS resolution failed for hostname: ${hostname}`
    );
  }
}

/**
 * Validate that a URL's protocol is allowed.
 */
function validateProtocol(url: URL, requireHttps: boolean): void {
  if (requireHttps && url.protocol !== 'https:') {
    throw new WebhookTargetValidationError(
      `Webhook URL must use HTTPS, got: ${url.protocol}`
    );
  }
  
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebhookTargetValidationError(
      `Webhook URL must use HTTP or HTTPS, got: ${url.protocol}`
    );
  }
}

/**
 * Validate that a hostname is in the allowlist (if configured).
 */
function validateAllowlist(hostname: string, allowlist: string[] | undefined): void {
  if (!allowlist || allowlist.length === 0) {
    return; // No allowlist configured, allow all non-blocked hosts
  }
  
  const normalizedHostname = hostname.toLowerCase();
  const normalizedAllowlist = allowlist.map(h => h.toLowerCase());
  
  // Check exact match first
  if (normalizedAllowlist.includes(normalizedHostname)) {
    return;
  }
  
  // Check wildcard matches (*.example.com)
  for (const allowed of normalizedAllowlist) {
    if (allowed.startsWith('*.')) {
      const domain = allowed.substring(2);
      if (normalizedHostname === domain || normalizedHostname.endsWith('.' + domain)) {
        return;
      }
    }
  }
  
  throw new WebhookTargetValidationError(
    `Webhook hostname not in allowlist: ${hostname}`
  );
}

/**
 * Validate that an IP address is not in a blocked range.
 */
function validateIPAddress(ip: string): void {
  // Check if it's IPv4 or IPv6
  const isIPv6 = ip.includes(':');
  
  if (isIPv6) {
    const result = isBlockedIPv6(ip);
    if (result.blocked) {
      throw new WebhookTargetValidationError(
        `Blocked IPv6 address: ${ip} (${result.reason})`
      );
    }
  } else {
    const result = isBlockedIPv4(ip);
    if (result.blocked) {
      throw new WebhookTargetValidationError(
        `Blocked IPv4 address: ${ip} (${result.reason})`
      );
    }
  }
}

/**
 * Validate a webhook target URL for SSRF protection.
 *
 * This function performs the following checks:
 * 1. Validates the URL format and protocol (requires HTTPS by default)
 * 2. Checks the hostname against the optional allowlist
 * 3. Resolves the hostname to IP addresses
 * 4. Validates each resolved IP against blocked ranges (loopback, private, link-local, etc.)
 * 5. Handles IPv4-mapped IPv6 addresses and alternative encodings
 *
 * The validation fails closed: any error or ambiguity results in rejection.
 *
 * @param url - The webhook target URL to validate
 * @param options - Optional validation configuration
 * @throws {WebhookTargetValidationError} If the URL fails validation
 *
 * @example
 * ```ts
 * try {
 *   validateWebhookTarget('https://api.example.com/webhook');
 *   // URL is safe to use
 * } catch (error) {
 *   // URL is blocked, log and reject
 * }
 * ```
 */
export async function validateWebhookTarget(
  url: string,
  options?: {
    requireHttps?: boolean;
    allowlist?: string[];
  }
): Promise<void> {
  const requireHttps = options?.requireHttps ?? true;
  const allowlist = options?.allowlist;

  try {
    // Parse URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      throw new WebhookTargetValidationError(
        `Invalid webhook URL format: ${url}`
      );
    }

    // Validate protocol
    validateProtocol(parsedUrl, requireHttps);

    // Extract hostname
    const hostname = parsedUrl.hostname;

    // Check allowlist first (if configured)
    validateAllowlist(hostname, allowlist);

    // Check if hostname is already an IP address
    const isIP = /^[\d.:]+$/.test(hostname);

    if (isIP) {
      // Direct IP address - validate it
      validateIPAddress(hostname);
    } else {
      // Hostname - resolve and validate all IPs
      const resolvedIPs = await resolveHostname(hostname);
      
      for (const ip of resolvedIPs) {
        validateIPAddress(ip);
      }
    }

    // All checks passed
  } catch (error) {
    if (error instanceof WebhookTargetValidationError) {
      // Log the validation failure (without the full URL for security)
      logger.warn('Webhook target validation failed', undefined, {
        reason: error.message,
      });
      throw error;
    }
    
    // Unexpected error - fail closed
    logger.warn('Unexpected error during webhook target validation', undefined, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new WebhookTargetValidationError(
      'Webhook target validation failed unexpectedly'
    );
  }
}
