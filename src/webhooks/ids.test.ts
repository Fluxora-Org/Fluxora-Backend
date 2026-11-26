import { describe, expect, it, vi } from 'vitest';
import { newId } from './ids.js';

describe('newId', () => {
  it.each(['outbox', 'dlq', 'deliv'] as const)('retains the %s prefix and adds a v4 UUID', (prefix) => {
    expect(newId(prefix)).toMatch(
      new RegExp(`^${prefix}_[0-9]+_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
    );
  });

  it('generates different IDs within the same millisecond', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const first = newId('outbox');
      const second = newId('outbox');
      expect(first).toMatch(/^outbox_1000_/);
      expect(second).toMatch(/^outbox_1000_/);
      expect(first).not.toBe(second);
    } finally {
      clock.mockRestore();
    }
  });
});
