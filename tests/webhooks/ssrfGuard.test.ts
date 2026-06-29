import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateWebhookTarget, WebhookTargetValidationError } from '../../src/webhooks/ssrfGuard.js';
import * as dns from 'dns';

// Mock dns promises lookup
vi.mock('dns', async (importOriginal) => {
  const original = await importOriginal<typeof import('dns')>();
  return {
    ...original,
    promises: {
      ...original.promises,
      lookup: vi.fn(),
    },
  };
});

describe('SSRF Guard DNS Timeout and Resolution', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should allow valid public IP resolved from hostname', async () => {
    vi.mocked(dns.promises.lookup).mockResolvedValue({ address: '8.8.8.8', family: 4 } as any);

    await expect(
      validateWebhookTarget('https://safe-domain.com/webhook', { dnsTimeoutMs: 500 })
    ).resolves.toBe('https://safe-domain.com/webhook');
  });

  it('should reject private IP resolved from hostname', async () => {
    vi.mocked(dns.promises.lookup).mockResolvedValue({ address: '192.168.1.1', family: 4 } as any);

    const promise = validateWebhookTarget('https://unsafe-domain.com/webhook', {
      dnsTimeoutMs: 500,
    });

    await expect(promise).rejects.toThrow(WebhookTargetValidationError);
    try {
      await promise;
    } catch (err: any) {
      expect(err.code).toBe('BLOCKED_ADDRESS');
      expect(err.message).toContain('Blocked IPv4 address');
    }
  });

  it('should time out and reject the target when DNS lookup hangs', async () => {
    // Mock a lookup that hangs forever
    vi.mocked(dns.promises.lookup).mockImplementation(() => {
      return new Promise(() => {
        // Never resolve or reject
      });
    });

    const startTime = Date.now();
    const promise = validateWebhookTarget('https://hanging-resolver.com/webhook', {
      dnsTimeoutMs: 100,
    });

    await expect(promise).rejects.toThrow(WebhookTargetValidationError);
    const duration = Date.now() - startTime;
    
    // Ensure the timeout actually fired around 100ms
    expect(duration).toBeGreaterThanOrEqual(90);
    expect(duration).toBeLessThan(500);

    // Verify that the error code is DNS_TIMEOUT
    try {
      await promise;
    } catch (err: any) {
      expect(err.code).toBe('DNS_TIMEOUT');
      expect(err.message).toContain('DNS resolution timed out');
    }
  });

  it('should fail closed when DNS lookup throws/rejects', async () => {
    vi.mocked(dns.promises.lookup).mockRejectedValue(new Error('ENOTFOUND'));

    const promise = validateWebhookTarget('https://some-failing-domain.com/webhook', {
      dnsTimeoutMs: 100,
    });

    await expect(promise).rejects.toThrow(WebhookTargetValidationError);

    try {
      await promise;
    } catch (err: any) {
      expect(err.code).toBe('DNS_RESOLUTION_FAILED');
      expect(err.message).toContain('DNS resolution failed');
    }
  });

  it('should abort the signal passed to lookup when timing out', async () => {
    let capturedSignal: AbortSignal | undefined;
    (dns.promises.lookup as any).mockImplementation((_hostname: string, options: any) => {
      capturedSignal = options?.signal;
      return new Promise<never>(() => {}); // hang
    });

    const promise = validateWebhookTarget('https://check-signal.com/webhook', {
      dnsTimeoutMs: 50,
    });

    await expect(promise).rejects.toThrow(WebhookTargetValidationError);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe('SSRF Guard IDNA and Homograph Normalization', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should normalize valid Unicode hostnames to punycode', async () => {
    vi.mocked(dns.promises.lookup).mockResolvedValue({ address: '8.8.8.8', family: 4 } as any);

    const result = await validateWebhookTarget('https://faß.de/webhook', { dnsTimeoutMs: 500 });
    expect(result).toBe('https://xn--fa-hia.de/webhook');
    
    expect(dns.promises.lookup).toHaveBeenCalledWith('xn--fa-hia.de', expect.any(Object));
  });

  it('should normalize homograph hostnames to punycode', async () => {
    vi.mocked(dns.promises.lookup).mockResolvedValue({ address: '8.8.8.8', family: 4 } as any);

    // Some environments normalize this to example.com, ensuring it doesn't bypass checks as raw unicode
    const result = await validateWebhookTarget('https://ⓔⓍⓐⓂⓅⓁⓔ.com/webhook', { dnsTimeoutMs: 500 });
    expect(result).toBe('https://example.com/webhook');
  });

  it('should reject hostnames that fail IDNA normalization or URL parsing', async () => {
    // Unpaired surrogates often fail URL parsing or IDNA normalization
    const promise = validateWebhookTarget('https://a\uD800b.com/webhook', { dnsTimeoutMs: 500 });
    
    await expect(promise).rejects.toThrow(WebhookTargetValidationError);
  });
});
