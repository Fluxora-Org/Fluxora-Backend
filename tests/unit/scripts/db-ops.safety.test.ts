import { describe, expect, it, vi } from 'vitest';
import { restoreDatabase } from '../../../src/scripts/db-ops.js';

const databaseUrl = 'postgresql://operator:secret@db.example.test:5432/fluxora';

describe('restoreDatabase – confirmation guards', () => {
  it('refuses a live restore without explicit confirmation', async () => {
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await restoreDatabase(databaseUrl, '/tmp/fluxora.dump', undefined, {
      targetEnvironment: 'staging',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('confirm: true');
    expect(logSpy.mock.calls.flat().join(' ')).toContain('target environment: staging');
    logSpy.mockRestore();
  });

  it('requires an additional acknowledgement for production restores', async () => {
    const result = await restoreDatabase(databaseUrl, '/tmp/fluxora.dump', undefined, {
      targetEnvironment: 'production',
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('acknowledgeProduction: true');
  });

  it('reports the planned restore in dry-run mode without reading the dump', async () => {
    const result = await restoreDatabase(databaseUrl, '/tmp/does-not-exist.dump', undefined, {
      dryRun: true,
      targetEnvironment: 'staging',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('[DRY RUN]');
    expect(result.message).toContain('/tmp/does-not-exist.dump');
    expect(result.message).toContain('staging');
    expect(result.message).toContain('pg_restore --clean');
  });
});
