import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { resetStreamIdempotencyStore } from '../../src/routes/streams.js';
import { streamRepository } from '../../src/db/repositories/streamRepository.js';

// Mock repository
vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    findWithCursor: vi.fn(),
  },
}));

// Mock auth middleware
vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    authenticateApiKey: (req: any, res: any, next: any) => next(),
    requireScope: () => (req: any, res: any, next: any) => next(),
  };
});

describe('GET /api/streams/export', () => {
  beforeEach(() => {
    resetStreamIdempotencyStore();
    vi.clearAllMocks();
  });

  it('should export streams in NDJSON format', async () => {
    // Setup mock to return two pages
    const stream1 = { id: 'stream-1', sender_address: 'S1', recipient_address: 'R1', amount: '100', streamed_amount: '0', remaining_amount: '100', rate_per_second: '1', start_time: 1000, end_time: 2000, status: 'active', contract_id: 'c1', transaction_hash: 'tx1', event_index: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const stream2 = { id: 'stream-2', sender_address: 'S2', recipient_address: 'R2', amount: '200', streamed_amount: '0', remaining_amount: '200', rate_per_second: '2', start_time: 1000, end_time: 3000, status: 'active', contract_id: 'c1', transaction_hash: 'tx2', event_index: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };

    ;(streamRepository.findWithCursor as any)
      .mockResolvedValueOnce({ streams: [stream1], hasMore: true })
      .mockResolvedValueOnce({ streams: [stream2], hasMore: false });

    // Call /api/streams/export
    // Assuming no authentication is required for this route as per the requirement or mock if needed.
    // Wait, the router has 'authenticateApiKey' and 'requireScope'. 
    // I need to bypass this or provide auth.
    // The previous tests used auth tokens or operators.
    
    // For now, let's assume I need to pass an API key or operator token.
    // Or I can mock the auth middleware. 
    // Let's try to pass an auth header.
    
    const response = await request(app)
      .get('/api/streams/export')
      .set('x-api-key', 'valid-api-key') // Assuming this is how it works
      .expect(200)
      .expect('Content-Type', /application\/x-ndjson/);

    const lines = response.text.trim().split('\n');
    expect(lines.length).toBe(4); // 2 streams + 2 cursors
    
    const record1 = JSON.parse(lines[0]);
    expect(record1.id).toBe('stream-1');
    
    const cursor1 = JSON.parse(lines[1]);
    expect(cursor1).toHaveProperty('resumption_cursor');
    
    const record2 = JSON.parse(lines[2]);
    expect(record2.id).toBe('stream-2');

    const cursor2 = JSON.parse(lines[3]);
    expect(cursor2).toHaveProperty('resumption_cursor');
  });
});
