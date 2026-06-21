import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repositoryPath = path.join(process.cwd(), 'src/db/repositories/streamRepository.ts');
const source = fs.readFileSync(repositoryPath, 'utf8');

describe('streamRepository offset ordering', () => {
  it('uses a unique deterministic tiebreaker for offset pages', () => {
    expect(source).toContain("export const STREAM_OFFSET_ORDER_BY = 'created_at DESC, id DESC'");
  });

  it('keeps the offset query ordered by fixed columns before LIMIT/OFFSET', () => {
    expect(source).toContain('ORDER BY ${STREAM_OFFSET_ORDER_BY} LIMIT');
    expect(source).not.toContain('ORDER BY created_at DESC LIMIT');
  });
});