import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns';
import fc from 'fast-check';
import {
  MAX_IP_ADDRESS_LENGTH,
  MAX_WEBHOOK_URL_LENGTH,
  validateWebhookIPAddress,
  validateWebhookTarget,
  WebhookTargetValidationError,
} from './ssrfGuard.js';

describe('ssrfGuard unit and boundary tests (src/webhooks/ssrfGuard.test.ts)', () => {
  let dnsLookupSpy: any;

  beforeEach(() => {
    // Default DNS lookup stub: resolves public hostnames to a public IP
    dnsLookupSpy = vi.spyOn(dns.promises, 'lookup').mockImplementation(async (hostname: string) => {
      if (hostname === 'public.example.com' || hostname === 'api.example.com') {
        return { address: '93.184.216.34', family: 4 };
      }
      if (hostname === 'ipv6.example.com') {
        return { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 };
      }
      if (hostname === 'internal.example.com') {
        return { address: '10.0.0.1', family: 4 };
      }
      if (hostname === 'loopback.example.com') {
        return { address: '127.0.0.1', family: 4 };
      }
      if (hostname === 'metadata.example.com') {
        return { address: '169.254.169.254', family: 4 };
      }
      if (hostname === 'nonexistent.example.com') {
        const err = new Error('getaddrinfo ENOTFOUND nonexistent.example.com');
        (err as any).code = 'ENOTFOUND';
        throw err;
      }
      return { address: '8.8.8.8', family: 4 };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Typed Error Verification
  // ─────────────────────────────────────────────────────────────────────────────
  describe('WebhookTargetValidationError typed error', () => {
    it('is an instance of Error with the correct name property', () => {
      const err = new WebhookTargetValidationError('test error');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(WebhookTargetValidationError);
      expect(err.name).toBe('WebhookTargetValidationError');
      expect(err.message).toBe('test error');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Empty Input Handling
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Empty input rejection', () => {
    it.each([
      ['empty string', ''],
      ['spaces only', '   '],
      ['tabs and newlines', '\t\r\n'],
      ['null (as any)', null as any],
      ['undefined (as any)', undefined as any],
    ])('validateWebhookTarget rejects %s with WebhookTargetValidationError', async (_, input) => {
      await expect(validateWebhookTarget(input)).rejects.toBeInstanceOf(WebhookTargetValidationError);
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it('validateWebhookTarget provides clear rejection message for empty URL', async () => {
      await expect(validateWebhookTarget('')).rejects.toThrow(
        /Webhook URL cannot be empty/i,
      );
      await expect(validateWebhookTarget('   ')).rejects.toThrow(
        /Webhook URL cannot be empty/i,
      );
    });

    it('validateWebhookTarget provides clear rejection message for non-string URL', async () => {
      await expect(validateWebhookTarget(null as any)).rejects.toThrow(
        /Webhook URL must be a string/i,
      );
      await expect(validateWebhookTarget(undefined as any)).rejects.toThrow(
        /Webhook URL must be a string/i,
      );
    });

    it.each([
      ['empty string', ''],
      ['spaces only', '   '],
      ['tabs and newlines', '\t\r\n'],
      ['null (as any)', null as any],
      ['undefined (as any)', undefined as any],
    ])('validateWebhookIPAddress rejects %s with WebhookTargetValidationError', (_, input) => {
      expect(() => validateWebhookIPAddress(input)).toThrow(WebhookTargetValidationError);
    });

    it('validateWebhookIPAddress provides clear rejection message for empty IP', () => {
      expect(() => validateWebhookIPAddress('')).toThrow(
        /IP address cannot be empty/i,
      );
      expect(() => validateWebhookIPAddress('   ')).toThrow(
        /IP address cannot be empty/i,
      );
    });

    it('validateWebhookIPAddress provides clear rejection message for non-string IP', () => {
      expect(() => validateWebhookIPAddress(null as any)).toThrow(
        /IP address must be a string/i,
      );
      expect(() => validateWebhookIPAddress(undefined as any)).toThrow(
        /IP address must be a string/i,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Oversized Input Handling
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Oversized input rejection', () => {
    it(`exports MAX_WEBHOOK_URL_LENGTH as ${MAX_WEBHOOK_URL_LENGTH}`, () => {
      expect(MAX_WEBHOOK_URL_LENGTH).toBe(2048);
    });

    it(`exports MAX_IP_ADDRESS_LENGTH as ${MAX_IP_ADDRESS_LENGTH}`, () => {
      expect(MAX_IP_ADDRESS_LENGTH).toBe(256);
    });

    it('accepts URL at exactly MAX_WEBHOOK_URL_LENGTH boundary', async () => {
      const baseUrl = 'https://public.example.com/';
      const padding = 'a'.repeat(MAX_WEBHOOK_URL_LENGTH - baseUrl.length);
      const exactUrl = baseUrl + padding;
      expect(exactUrl.length).toBe(MAX_WEBHOOK_URL_LENGTH);

      await expect(validateWebhookTarget(exactUrl)).resolves.toBeUndefined();
    });

    it('rejects URL with length MAX_WEBHOOK_URL_LENGTH + 1 as oversized', async () => {
      const baseUrl = 'https://public.example.com/';
      const padding = 'a'.repeat(MAX_WEBHOOK_URL_LENGTH - baseUrl.length + 1);
      const oversizedUrl = baseUrl + padding;
      expect(oversizedUrl.length).toBe(MAX_WEBHOOK_URL_LENGTH + 1);

      await expect(validateWebhookTarget(oversizedUrl)).rejects.toThrow(
        /exceeds maximum length of 2048 characters/i,
      );
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it('rejects massive URL (50KB) immediately without DNS lookup', async () => {
      const massiveUrl = 'https://public.example.com/' + 'x'.repeat(50_000);

      await expect(validateWebhookTarget(massiveUrl)).rejects.toThrow(
        WebhookTargetValidationError,
      );
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it('rejects IP address exceeding MAX_IP_ADDRESS_LENGTH', () => {
      const oversizedIp = '1'.repeat(MAX_IP_ADDRESS_LENGTH + 1);

      expect(() => validateWebhookIPAddress(oversizedIp)).toThrow(
        /IP address exceeds maximum length of 256 characters/i,
      );
    });

    it('rejects massive IP string without memory bloat', () => {
      const massiveIp = '9'.repeat(10_000);

      expect(() => validateWebhookIPAddress(massiveIp)).toThrow(
        WebhookTargetValidationError,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Malformed Input Handling
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Malformed URL rejection', () => {
    it.each([
      ['number', 12345],
      ['boolean true', true],
      ['boolean false', false],
      ['object', { url: 'https://example.com' }],
      ['array', ['https://example.com']],
    ])('validateWebhookTarget rejects non-string type %s', async (_, val) => {
      await expect(validateWebhookTarget(val as any)).rejects.toBeInstanceOf(
        WebhookTargetValidationError,
      );
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['plain text without scheme', 'not-a-url'],
      ['missing scheme', '//example.com/webhook'],
      ['only scheme and colon', 'http:'],
      ['scheme with no host', 'http://'],
      ['https scheme with no host', 'https://'],
      ['colon with no host or port', 'http://:'],
      ['port with no host', 'http://:80'],
      ['whitespace in authority', 'http:// /'],
      ['query string without host', 'https://?query=1'],
      ['ftp protocol', 'ftp://example.com/resource'],
      ['file protocol', 'file:///etc/passwd'],
      ['javascript protocol', 'javascript:alert(1)'],
      ['data protocol', 'data:text/html,<h1>test</h1>'],
      ['gopher protocol', 'gopher://example.com/'],
      ['invalid port (out of range)', 'https://example.com:99999/'],
      ['invalid port (negative)', 'https://example.com:-1/'],
      ['invalid port (alphabetic)', 'https://example.com:abc/'],
      ['malformed bracketed IPv6', 'https://[invalid-ipv6]/'],
      ['unclosed bracketed IPv6', 'https://[fe80::1/webhook'],
      ['extra colons in IPv6 host', 'https://[:::1]/'],
    ])('rejects malformed URL: %s', async (_, malformedUrl) => {
      await expect(validateWebhookTarget(malformedUrl, { requireHttps: false })).rejects.toBeInstanceOf(
        WebhookTargetValidationError,
      );
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it('rejects HTTP URL when requireHttps defaults to true', async () => {
      await expect(validateWebhookTarget('http://public.example.com/webhook')).rejects.toThrow(
        /Webhook URL must use HTTPS, got: http:/i,
      );
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it('rejects unsupported protocol even when requireHttps is false', async () => {
      await expect(
        validateWebhookTarget('ftp://public.example.com/file', { requireHttps: false }),
      ).rejects.toThrow(/Webhook URL must use HTTP or HTTPS, got: ftp:/i);
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it('rejects options when options is not an object', async () => {
      await expect(
        validateWebhookTarget('https://public.example.com/hook', 'not-an-object' as any),
      ).rejects.toThrow(/Options must be an object/i);
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it('rejects allowlist when allowlist is not an array', async () => {
      await expect(
        validateWebhookTarget('https://public.example.com/hook', {
          allowlist: 'invalid-string' as any,
        }),
      ).rejects.toThrow(/Allowlist must be an array of hostnames/i);
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it('rejects allowlist containing empty or non-string entries', async () => {
      await expect(
        validateWebhookTarget('https://public.example.com/hook', {
          allowlist: ['valid.com', ''],
        }),
      ).rejects.toThrow(/Allowlist entries must be non-empty strings/i);

      await expect(
        validateWebhookTarget('https://public.example.com/hook', {
          allowlist: ['valid.com', 123 as any],
        }),
      ).rejects.toThrow(/Allowlist entries must be non-empty strings/i);
    });
  });

  describe('Malformed IP address rejection', () => {
    it.each([
      ['number', 12345],
      ['boolean', true],
      ['object', {}],
      ['array', [1, 2, 3]],
    ])('validateWebhookIPAddress rejects non-string type %s', (_, val) => {
      expect(() => validateWebhookIPAddress(val as any)).toThrow(
        WebhookTargetValidationError,
      );
    });

    it.each([
      ['not an IP', 'not-an-ip'],
      ['domain name', 'example.com'],
      ['localhost hostname', 'localhost'],
      ['too few IPv4 octets', '1.2.3'],
      ['too many IPv4 octets', '1.2.3.4.5'],
      ['non-numeric IPv4 octet', '1.2.3.a'],
      ['negative IPv4 octet', '1.2.3.-1'],
      ['IPv4 octet > 255', '256.0.0.1'],
      ['IPv4 octet 999', '1.2.3.999'],
      ['double dot in IPv4', '1..2.3.4'],
      ['trailing dot in IPv4', '1.2.3.4.'],
      ['IPv4 with letters', '1.2.foo.4'],
      ['IPv6 with triple colons', ':::1'],
      ['IPv6 with multiple double colons', '2001:db8::1::2'],
      ['IPv6 with invalid hex characters', '2001:xyz::1'],
      ['IPv6 with unclosed bracket', '[fe80::1'],
      ['IPv6 with unopened bracket', 'fe80::1]'],
      ['IPv6 section > 4 hex digits', '2001:12345::1'],
    ])('rejects malformed IP address: %s', (_, malformedIp) => {
      expect(() => validateWebhookIPAddress(malformedIp)).toThrow(
        WebhookTargetValidationError,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Blocked Ranges and SSRF Edge Cases
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Blocked IP ranges and SSRF protection', () => {
    describe('IPv4 blocked ranges', () => {
      it.each([
        ['loopback 127.0.0.1', '127.0.0.1'],
        ['loopback 127.0.0.2', '127.0.0.2'],
        ['loopback 127.255.255.255', '127.255.255.255'],
        ['loopback start 127.0.0.0', '127.0.0.0'],
        ['link-local AWS metadata 169.254.169.254', '169.254.169.254'],
        ['link-local start 169.254.0.0', '169.254.0.0'],
        ['link-local end 169.254.255.255', '169.254.255.255'],
        ['private-10 start 10.0.0.0', '10.0.0.0'],
        ['private-10 internal 10.1.2.3', '10.1.2.3'],
        ['private-10 end 10.255.255.255', '10.255.255.255'],
        ['private-172 start 172.16.0.0', '172.16.0.0'],
        ['private-172 internal 172.20.1.1', '172.20.1.1'],
        ['private-172 end 172.31.255.255', '172.31.255.255'],
        ['private-192 start 192.168.0.0', '192.168.0.0'],
        ['private-192 router 192.168.1.1', '192.168.1.1'],
        ['private-192 end 192.168.255.255', '192.168.255.255'],
        ['reserved-0 broadcast 0.0.0.0', '0.0.0.0'],
        ['reserved-0 internal 0.1.2.3', '0.1.2.3'],
        ['reserved-0 end 0.255.255.255', '0.255.255.255'],
        ['reserved-240 start 240.0.0.0', '240.0.0.0'],
        ['reserved-240 internal 250.1.2.3', '250.1.2.3'],
        ['reserved-240 broadcast 255.255.255.255', '255.255.255.255'],
        ['multicast start 224.0.0.0', '224.0.0.0'],
        ['multicast all-hosts 224.0.0.1', '224.0.0.1'],
        ['multicast end 239.255.255.255', '239.255.255.255'],
      ])('blocks IPv4 address %s via validateWebhookIPAddress', (_, ip) => {
        expect(() => validateWebhookIPAddress(ip)).toThrow(WebhookTargetValidationError);
      });

      it.each([
        ['127.0.0.1', 'Loopback'],
        ['169.254.169.254', 'Link-local'],
        ['10.0.0.1', 'Private network'],
        ['172.16.0.1', 'Private network'],
        ['192.168.1.1', 'Private network'],
        ['0.0.0.0', 'Reserved'],
        ['240.0.0.1', 'Reserved'],
        ['224.0.0.1', 'Multicast'],
      ])('tells caller why IPv4 %s was blocked', (ip, expectedReason) => {
        expect(() => validateWebhookIPAddress(ip)).toThrow(
          new RegExp(`Blocked IPv4 address: ${ip}.*${expectedReason}`, 'i'),
        );
      });
    });

    describe('IPv6 blocked ranges', () => {
      it.each([
        ['IPv6 loopback ::1', '::1'],
        ['IPv6 loopback bracketed [::1]', '[::1]'],
        ['IPv6 unspecified ::', '::'],
        ['IPv6 link-local fe80::1', 'fe80::1'],
        ['IPv6 link-local fe80::2', 'fe80::2'],
        ['IPv6 link-local febf::ffff', 'febf::ffff'],
        ['IPv6 unique local (ULA) fc00::1', 'fc00::1'],
        ['IPv6 unique local (ULA) fd00::1', 'fd00::1'],
        ['IPv6 unique local fd12:3456:789a::1', 'fd12:3456:789a::1'],
        ['IPv4-mapped loopback ::ffff:127.0.0.1', '::ffff:127.0.0.1'],
        ['IPv4-mapped metadata ::ffff:169.254.169.254', '::ffff:169.254.169.254'],
        ['IPv4-mapped private ::ffff:10.0.0.1', '::ffff:10.0.0.1'],
        ['IPv4-mapped private ::ffff:192.168.1.1', '::ffff:192.168.1.1'],
        ['IPv4-mapped private ::ffff:172.16.0.1', '::ffff:172.16.0.1'],
        ['IPv4-mapped reserved ::ffff:0.0.0.0', '::ffff:0.0.0.0'],
        ['IPv4-mapped multicast ::ffff:224.0.0.1', '::ffff:224.0.0.1'],
      ])('blocks IPv6 address %s via validateWebhookIPAddress', (_, ip) => {
        expect(() => validateWebhookIPAddress(ip)).toThrow(WebhookTargetValidationError);
      });

      it('tells caller why IPv6 ::1 was blocked', () => {
        expect(() => validateWebhookIPAddress('::1')).toThrow(
          /Blocked IPv6 address: ::1 \(IPv6 loopback address\)/i,
        );
      });

      it('tells caller why IPv6 :: was blocked', () => {
        expect(() => validateWebhookIPAddress('::')).toThrow(
          /Blocked IPv6 address: :: \(IPv6 unspecified address\)/i,
        );
      });

      it('tells caller why IPv6 fe80::1 was blocked', () => {
        expect(() => validateWebhookIPAddress('fe80::1')).toThrow(
          /Blocked IPv6 address: fe80::1 \(IPv6 link-local address\)/i,
        );
      });

      it('tells caller why IPv6 fc00::1 was blocked', () => {
        expect(() => validateWebhookIPAddress('fc00::1')).toThrow(
          /Blocked IPv6 address: fc00::1 \(IPv6 unique local address \(private\)\)/i,
        );
      });
    });

    describe('Direct IP in URL validation', () => {
      it('blocks direct private IPv4 URL without DNS lookup', async () => {
        await expect(
          validateWebhookTarget('https://10.0.0.1/webhook'),
        ).rejects.toBeInstanceOf(WebhookTargetValidationError);
        expect(dnsLookupSpy).not.toHaveBeenCalled();
      });

      it('blocks direct link-local IPv4 URL (AWS metadata) without DNS lookup', async () => {
        await expect(
          validateWebhookTarget('https://169.254.169.254/latest/meta-data/'),
        ).rejects.toBeInstanceOf(WebhookTargetValidationError);
        expect(dnsLookupSpy).not.toHaveBeenCalled();
      });

      it('blocks direct loopback IPv6 URL without DNS lookup', async () => {
        await expect(
          validateWebhookTarget('https://[::1]/webhook'),
        ).rejects.toBeInstanceOf(WebhookTargetValidationError);
        expect(dnsLookupSpy).not.toHaveBeenCalled();
      });

      it('blocks direct IPv4-mapped IPv6 loopback without DNS lookup', async () => {
        await expect(
          validateWebhookTarget('https://[::ffff:127.0.0.1]/webhook'),
        ).rejects.toBeInstanceOf(WebhookTargetValidationError);
        expect(dnsLookupSpy).not.toHaveBeenCalled();
      });
    });

    describe('DNS Resolution and Rebinding SSRF Protection', () => {
      it('blocks hostname resolving to internal private IP', async () => {
        await expect(
          validateWebhookTarget('https://internal.example.com/webhook'),
        ).rejects.toThrow(/Blocked IPv4 address: 10.0.0.1/i);
        expect(dnsLookupSpy).toHaveBeenCalledWith('internal.example.com', { all: false });
      });

      it('blocks hostname resolving to loopback IP', async () => {
        await expect(
          validateWebhookTarget('https://loopback.example.com/webhook'),
        ).rejects.toThrow(/Blocked IPv4 address: 127.0.0.1/i);
        expect(dnsLookupSpy).toHaveBeenCalledWith('loopback.example.com', { all: false });
      });

      it('blocks hostname resolving to cloud metadata IP', async () => {
        await expect(
          validateWebhookTarget('https://metadata.example.com/webhook'),
        ).rejects.toThrow(/Blocked IPv4 address: 169.254.169.254/i);
        expect(dnsLookupSpy).toHaveBeenCalledWith('metadata.example.com', { all: false });
      });

      it('fails closed when DNS resolution fails (ENOTFOUND)', async () => {
        await expect(
          validateWebhookTarget('https://nonexistent.example.com/webhook'),
        ).rejects.toThrow(/DNS resolution failed for hostname: nonexistent.example.com/i);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Allowlist Filtering
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Allowlist validation', () => {
    it('allows hostname matching exact allowlist entry', async () => {
      await expect(
        validateWebhookTarget('https://api.example.com/webhook', {
          allowlist: ['api.example.com'],
        }),
      ).resolves.toBeUndefined();
    });

    it('allows hostname matching exact allowlist entry with case insensitivity', async () => {
      await expect(
        validateWebhookTarget('https://API.EXAMPLE.COM/webhook', {
          allowlist: ['api.example.com'],
        }),
      ).resolves.toBeUndefined();
    });

    it('allows subdomain matching wildcard allowlist entry (*.example.com)', async () => {
      await expect(
        validateWebhookTarget('https://api.example.com/webhook', {
          allowlist: ['*.example.com'],
        }),
      ).resolves.toBeUndefined();
    });

    it('allows root domain matching wildcard allowlist entry (*.example.com -> example.com)', async () => {
      dnsLookupSpy.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 });
      await expect(
        validateWebhookTarget('https://example.com/webhook', {
          allowlist: ['*.example.com'],
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects hostname not matching allowlist', async () => {
      await expect(
        validateWebhookTarget('https://api.example.com/webhook', {
          allowlist: ['partner.org', '*.trusted.com'],
        }),
      ).rejects.toThrow(/Webhook hostname not in allowlist: api.example.com/i);
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it('does not allow wildcard match to match unintended suffix (evil-example.com vs *.example.com)', async () => {
      await expect(
        validateWebhookTarget('https://evil-example.com/webhook', {
          allowlist: ['*.example.com'],
        }),
      ).rejects.toThrow(/Webhook hostname not in allowlist: evil-example.com/i);
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Valid Input Unaffected
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Valid input acceptance', () => {
    it('accepts valid public HTTPS endpoint', async () => {
      await expect(validateWebhookTarget('https://public.example.com/webhook')).resolves.toBeUndefined();
      expect(dnsLookupSpy).toHaveBeenCalledWith('public.example.com', { all: false });
    });

    it('accepts valid public HTTPS endpoint with port, query, and hash', async () => {
      await expect(
        validateWebhookTarget('https://public.example.com:8443/v1/events?source=fluxora#section'),
      ).resolves.toBeUndefined();
    });

    it('accepts public HTTP endpoint when requireHttps is false', async () => {
      await expect(
        validateWebhookTarget('http://public.example.com/webhook', { requireHttps: false }),
      ).resolves.toBeUndefined();
    });

    it('accepts direct public IPv4 address without DNS resolution', async () => {
      await expect(validateWebhookTarget('https://8.8.8.8/webhook')).resolves.toBeUndefined();
      await expect(validateWebhookTarget('https://1.1.1.1/webhook')).resolves.toBeUndefined();
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it('accepts direct public IPv6 address without DNS resolution', async () => {
      await expect(
        validateWebhookTarget('https://[2001:4860:4860::8888]/webhook'),
      ).resolves.toBeUndefined();
      expect(dnsLookupSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['Google DNS 8.8.8.8', '8.8.8.8'],
      ['Cloudflare DNS 1.1.1.1', '1.1.1.1'],
      ['Example.com IPv4 93.184.216.34', '93.184.216.34'],
      ['Cloudflare IPv6 2606:4700:4700::1111', '2606:4700:4700::1111'],
      ['Google IPv6 2001:4860:4860::8888', '2001:4860:4860::8888'],
      ['Public IPv4-mapped IPv6 ::ffff:8.8.8.8', '::ffff:8.8.8.8'],
    ])('validateWebhookIPAddress accepts valid public IP %s', (_, ip) => {
      expect(() => validateWebhookIPAddress(ip)).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Property-Based Fuzzing with fast-check
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Property-based fuzzing (fail-closed robustness)', () => {
    it('always rejects arbitrary non-string values with WebhookTargetValidationError', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.anything().filter((v) => typeof v !== 'string'),
          async (nonStringVal) => {
            await expect(validateWebhookTarget(nonStringVal as any)).rejects.toBeInstanceOf(
              WebhookTargetValidationError,
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('never crashes on arbitrary random strings in validateWebhookIPAddress', () => {
      fc.assert(
        fc.property(fc.string(), (randomStr) => {
          try {
            validateWebhookIPAddress(randomStr);
          } catch (err) {
            // Must always throw a typed WebhookTargetValidationError, never crash with TypeError or unhandled Error
            expect(err).toBeInstanceOf(WebhookTargetValidationError);
          }
        }),
        { numRuns: 200 },
      );
    });

    it('never crashes on arbitrary random strings in validateWebhookTarget', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (randomStr) => {
          try {
            await validateWebhookTarget(randomStr);
          } catch (err) {
            // Must always throw a typed WebhookTargetValidationError
            expect(err).toBeInstanceOf(WebhookTargetValidationError);
          }
        }),
        { numRuns: 200 },
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Fail-Closed Unexpected Error Handling
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Fail-closed on unexpected internal faults', () => {
    it('wraps unexpected non-validation errors into WebhookTargetValidationError', async () => {
      vi.spyOn(dns.promises, 'lookup').mockImplementationOnce(() => {
        // Bypass resolveHostname catch block by throwing a raw symbol or fault
        throw new TypeError('Simulated unexpected low-level fault');
      });

      // The resolveHostname catch handles DNS errors and throws WebhookTargetValidationError.
      // But if an unexpected error occurs in validateWebhookTarget, it fails closed.
      await expect(
        validateWebhookTarget('https://api.example.com/webhook'),
      ).rejects.toBeInstanceOf(WebhookTargetValidationError);
    });

    it('accepts fully expanded 8-section IPv6 address', () => {
      expect(() =>
        validateWebhookIPAddress('2001:0db8:0000:0000:0000:0000:0000:0001'),
      ).not.toThrow();
    });

    it('blocks fully expanded 8-section loopback IPv6 address', () => {
      expect(() =>
        validateWebhookIPAddress('0000:0000:0000:0000:0000:0000:0000:0001'),
      ).toThrow(/loopback/i);
    });
  });
});

