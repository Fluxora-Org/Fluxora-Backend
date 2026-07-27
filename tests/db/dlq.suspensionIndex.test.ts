import { describe, expect, it, vi } from 'vitest';

import { up } from '../../migrations/20260626000000_add_dlq_consumer_suspension_topic_index.js';

describe('dlq consumer suspension topic index migration', () => {
  it('creates the topic index with IF NOT EXISTS', async () => {
    const createIndex = vi.fn();
    const pgm = {
      createIndex,
    } as any;

    await up(pgm);

    expect(createIndex).toHaveBeenCalledWith(
      'dlq_consumer_suspension',
      'topic',
      { ifNotExists: true, name: 'idx_dlq_consumer_suspension_topic' },
    );
  });
});
