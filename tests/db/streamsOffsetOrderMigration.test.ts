import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(process.cwd(), 'migrations/20260621_streams_offset_order_tiebreaker.ts');
const source = fs.readFileSync(migrationPath, 'utf8');

describe('streams offset ordering migration', () => {
  it('creates a composite index matching offset pagination order', () => {
    expect(source).toContain('CREATE INDEX IF NOT EXISTS idx_streams_created_at_id');
    expect(source).toContain('ON streams (created_at DESC, id DESC)');
  });

  it('replaces and restores the legacy created_at index deterministically', () => {
    expect(source).toContain('DROP INDEX IF EXISTS idx_streams_created_at;');
    expect(source).toContain('DROP INDEX IF EXISTS idx_streams_created_at_id;');
    expect(source).toContain('CREATE INDEX IF NOT EXISTS idx_streams_created_at');
    expect(source).toContain('ON streams (created_at)');
  });
});