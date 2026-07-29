import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdempotencyHelper, IdempotencyError, ICacheStore, Logger } from '../../../sdk/typescript/src/idempotency.js';

describe('IdempotencyHelper', () => {
  let mockStore: ICacheStore;
  let mockLogger: Logger;
  let helper: IdempotencyHelper;

  beforeEach(() => {
    mockStore = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    helper = new IdempotencyHelper(mockStore, mockLogger);
  });

  it('throws an error if idempotencyKey is missing or invalid', async () => {
    await expect(
      helper.execute(
        { idempotencyKey: '', callerId: 'user-1' },
        async () => ({ response: 'success', statusCode: 200 })
      )
    ).rejects.toThrowError(IdempotencyError);
    
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Idempotency validation failed: Invalid idempotency key',
      expect.any(Object)
    );
  });

  it('throws an error if callerId is missing or invalid', async () => {
    await expect(
      helper.execute(
        { idempotencyKey: 'key-123', callerId: '   ' },
        async () => ({ response: 'success', statusCode: 200 })
      )
    ).rejects.toThrowError(IdempotencyError);
  });

  it('returns cached response if one exists', async () => {
    const cachedResponse = { response: 'cached', statusCode: 201 };
    mockStore.get = vi.fn().mockResolvedValue(cachedResponse);

    const result = await helper.execute(
      { idempotencyKey: 'key-123', callerId: 'user-1' },
      async () => ({ response: 'new', statusCode: 200 })
    );

    expect(result).toEqual({ ...cachedResponse, cached: true });
    expect(mockStore.acquireLock).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Idempotency cache hit',
      expect.any(Object)
    );
  });

  it('throws CONCURRENT_REQUEST if lock cannot be acquired', async () => {
    mockStore.acquireLock = vi.fn().mockResolvedValue(false);

    await expect(
      helper.execute(
        { idempotencyKey: 'key-123', callerId: 'user-1' },
        async () => ({ response: 'success', statusCode: 200 })
      )
    ).rejects.toThrowError(IdempotencyError);
    
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Concurrent request collision',
      expect.any(Object)
    );
  });

  it('executes operation and caches result on success', async () => {
    const operation = vi.fn().mockResolvedValue({ response: 'fresh', statusCode: 200 });

    const result = await helper.execute(
      { idempotencyKey: 'key-123', callerId: 'user-1' },
      operation
    );

    expect(result).toEqual({ response: 'fresh', statusCode: 200, cached: false });
    expect(operation).toHaveBeenCalled();
    expect(mockStore.set).toHaveBeenCalledWith(
      'idempotency:user-1:key-123',
      { response: 'fresh', statusCode: 200 },
      86400
    );
    expect(mockStore.releaseLock).toHaveBeenCalledWith('idempotency:user-1:key-123:lock');
  });

  it('releases lock if operation throws', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('Operation failed'));

    await expect(
      helper.execute(
        { idempotencyKey: 'key-123', callerId: 'user-1' },
        operation
      )
    ).rejects.toThrow('Operation failed');

    expect(mockStore.set).not.toHaveBeenCalled();
    expect(mockStore.releaseLock).toHaveBeenCalledWith('idempotency:user-1:key-123:lock');
  });

  it('documents validation, retry, caller-scoped cache keys, and observability hooks', () => {
    const helperSource = readFileSync(new URL('../../../sdk/typescript/src/idempotency.ts', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../../../sdk/typescript/README.md', import.meta.url), 'utf8');

    const helperText = helperSource.toLowerCase();
    const readmeText = readme.toLowerCase();

    expect(helperText).toContain('retry semantics');
    expect(helperText).toContain('caller-scoped cache keys');
    expect(helperText).toContain('observability hooks');
    expect(readmeText).toContain('caller-scoped cache keys');
    expect(readmeText).toContain('observability hooks');
  });
});
