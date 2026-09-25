import { describe, expect, it } from 'vitest';
import { PaginationSchema } from './paginationSchema.js';

describe('stream list query validation', () => {
  it('accepts supported filters and bounded limits', () => {
    const parsed = PaginationSchema.safeParse({
      status: 'active',
      sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
      recipient: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR',
      limit: '100',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBe(100);
  });

  it('rejects status values that could otherwise flow into a SQL predicate', () => {
    const parsed = PaginationSchema.safeParse({ status: "active' OR 1=1 --" });

    expect(parsed.success).toBe(false);
  });

  it('rejects unsupported query keys such as an unimplemented sort selector', () => {
    const parsed = PaginationSchema.safeParse({ sort: 'created_at DESC' });

    expect(parsed.success).toBe(false);
  });

  it('rejects limits outside the documented 1–100 boundary', () => {
    expect(PaginationSchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(PaginationSchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(PaginationSchema.safeParse({ limit: '1' }).success).toBe(true);
  });
});
