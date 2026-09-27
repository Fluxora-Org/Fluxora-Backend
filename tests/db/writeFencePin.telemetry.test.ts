import { afterEach, describe, expect, it, vi } from 'vitest';
import { registry } from '../../src/metrics.js';
import { dbWriteFenceRejectedTotal } from '../../src/metrics/dbMetrics.js';
import { verifyWriteFencePin } from '../../src/db/writeFencePin.js';
import { logger } from '../../src/lib/logger.js';

describe('write-fence rejection telemetry', () => {
  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.RYW_PIN_TTL_SECONDS;
    vi.restoreAllMocks();
  });

  it('counts and logs malformed pins without exposing their contents', async () => {
    process.env.JWT_SECRET = 'a'.repeat(32);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const before = (await dbWriteFenceRejectedTotal.get()).values
      .find((value) => value.labels.reason === 'malformed')?.value ?? 0;

    expect(verifyWriteFencePin('not-a-pin')).toBe(false);

    const after = (await dbWriteFenceRejectedTotal.get()).values
      .find((value) => value.labels.reason === 'malformed')?.value ?? 0;
    expect(after).toBe(before + 1);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls.at(-1)?.[0])).not.toContain('not-a-pin');
  });

  it('documents the rejection metric in the Prometheus registry', async () => {
    const metric = await registry.getSingleMetric('fluxora_db_write_fence_rejected_total')?.get();
    expect(metric?.name).toBe('fluxora_db_write_fence_rejected_total');
    expect(metric?.help).toContain('invalid, expired, or unverifiable');
  });
});
