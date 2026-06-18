/**
 * DB Transaction Tests — placeholder.
 *
 * The original suite exercised the SQLite-backed transactional helpers
 * (`transactionalUpsertStream`, `transactionalUpdateStream`, …) that were
 * removed when storage migrated to PostgreSQL.  The corresponding scenarios
 * (audit + outbox rollback, decimal-string preservation, etc.) are now
 * covered by the integration tests against the live pg-pool repository, so
 * this file is intentionally inert.  See CHANGES_DETAILED.md.
 */
import { describe, it } from 'vitest';

describe.skip('DB Transaction Tests — SQLite path (legacy, removed)', () => {
  it('legacy SQLite transactional helpers were removed in the PG migration', () => {
    // No-op: tests intentionally skipped.
  });
});
