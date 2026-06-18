import { IndexerService, replayState } from '../../src/indexer/service';
import { db } from '../../src/db/client';
import { ReplayRequest } from '../../src/types';

// Mock the database client
jest.mock('../../src/db/client');

describe('IndexerService - Replay Events', () => {
  let service: IndexerService;
  let mockClient: any;

  beforeEach(() => {
    service = new IndexerService(100); // Use smaller batch size for tests
    
    // Reset replay state
    (replayState as any).state = {
      isReplaying: false,
      rowsReplayed: 0,
      rowsRemaining: 0,
      totalRows: 0,
      estimatedCompletion: null,
      startedAt: null,
    };

    // Setup mock client
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    
    (db.getClient as jest.Mock).mockResolvedValue(mockClient);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Input Validation', () => {
    it('should reject invalid contract_id', async () => {
      const request: any = {
        contract_id: '',
        ledger: 1,
      };

      await expect(service.replayEvents(request)).rejects.toThrow('Invalid contract_id');
    });

    it('should reject invalid ledger', async () => {
      const request: any = {
        contract_id: 'contract-123',
        ledger: -1,
      };

      await expect(service.replayEvents(request)).rejects.toThrow('Invalid ledger');
    });

    it('should reject invalid from_block', async () => {
      const request: any = {
        contract_id: 'contract-123',
        ledger: 1,
        from_block: -5,
      };

      await expect(service.replayEvents(request)).rejects.toThrow('Invalid from_block');
    });

    it('should reject from_block > to_block', async () => {
      const request: any = {
        contract_id: 'contract-123',
        ledger: 1,
        from_block: 100,
        to_block: 50,
      };

      await expect(service.replayEvents(request)).rejects.toThrow(
        'from_block must be less than or equal to to_block'
      );
    });
  });

  describe('Empty Replay Set', () => {
    it('should handle empty replay set gracefully', async () => {
      const request: ReplayRequest = {
        contract_id: 'contract-123',
        ledger: 1,
      };

      // Mock count query returning 0
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // COUNT
        .mockResolvedValueOnce(undefined); // COMMIT

      await service.replayEvents(request);

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
      
      const progress = service.getReplayProgress();
      expect(progress.isReplaying).toBe(false);
      expect(progress.rowsReplayed).toBe(0);
    });
  });

  describe('Batch Processing', () => {
    it('should process events in batches', async () => {
      const request: ReplayRequest = {
        contract_id: 'contract-123',
        ledger: 1,
      };

      const mockEvents = Array.from({ length: 250 }, (_, i) => ({
        event_id: `event-${i}`,
        contract_id: 'contract-123',
        ledger: 1,
        event_type: 'Transfer',
        event_data: { amount: 100 },
        block_height: 1000 + i,
        transaction_hash: `tx-${i}`,
      }));

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '250' }] }) // COUNT
        .mockResolvedValueOnce({ rows: mockEvents.slice(0, 100) }) // Batch 1
        .mockResolvedValueOnce(undefined) // INSERT batch 1
        .mockResolvedValueOnce({ rows: mockEvents.slice(100, 200) }) // Batch 2
        .mockResolvedValueOnce(undefined) // INSERT batch 2
        .mockResolvedValueOnce({ rows: mockEvents.slice(200, 250) }) // Batch 3
        .mockResolvedValueOnce(undefined) // INSERT batch 3
        .mockResolvedValueOnce({ rows: [] }) // No more events
        .mockResolvedValueOnce(undefined); // COMMIT

      await service.replayEvents(request);

      const progress = service.getReplayProgress();
      expect(progress.rowsReplayed).toBe(250);
      expect(progress.isReplaying).toBe(false);
    });

    it('should handle batch boundary alignment correctly', async () => {
      const request: ReplayRequest = {
        contract_id: 'contract-123',
        ledger: 1,
      };

      // Exactly 100 events (one batch)
      const mockEvents = Array.from({ length: 100 }, (_, i) => ({
        event_id: `event-${i}`,
        contract_id: 'contract-123',
        ledger: 1,
        event_type: 'Transfer',
        event_data: { amount: 100 },
        block_height: 1000 + i,
        transaction_hash: `tx-${i}`,
      }));

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '100' }] }) // COUNT
        .mockResolvedValueOnce({ rows: mockEvents }) // Batch 1
        .mockResolvedValueOnce(undefined) // INSERT batch 1
        .mockResolvedValueOnce({ rows: [] }) // No more events
        .mockResolvedValueOnce(undefined); // COMMIT

      await service.replayEvents(request);

      const progress = service.getReplayProgress();
      expect(progress.rowsReplayed).toBe(100);
      expect(progress.rowsRemaining).toBe(0);
    });
  });

  describe('Duplicate Event Handling', () => {
    it('should use ON CONFLICT DO NOTHING for duplicate event_ids', async () => {
      const request: ReplayRequest = {
        contract_id: 'contract-123',
        ledger: 1,
      };

      const mockEvents = [
        {
          event_id: 'event-1',
          contract_id: 'contract-123',
          ledger: 1,
          event_type: 'Transfer',
          event_data: { amount: 100 },
          block_height: 1000,
          transaction_hash: 'tx-1',
        },
      ];

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // COUNT
        .mockResolvedValueOnce({ rows: mockEvents }) // Batch 1
        .mockResolvedValueOnce(undefined) // INSERT batch 1
        .mockResolvedValueOnce({ rows: [] }) // No more events
        .mockResolvedValueOnce(undefined); // COMMIT

      await service.replayEvents(request);

      // Verify INSERT query contains ON CONFLICT clause
      const insertCall = mockClient.query.mock.calls.find((call: any) =>
        call[0].includes('INSERT INTO contract_events')
      );
      expect(insertCall[0]).toContain('ON CONFLICT (event_id) DO NOTHING');
    });
  });

  describe('Concurrent Replay Prevention', () => {
    it('should prevent concurrent replay operations', async () => {
      const request: ReplayRequest = {
        contract_id: 'contract-123',
        ledger: 1,
      };

      // Set replay state to in-progress
      (replayState as any).state.isReplaying = true;

      await expect(service.replayEvents(request)).rejects.toThrow(
        'Replay operation already in progress'
      );
    });
  });

  describe('Transaction Rollback on Error', () => {
    it('should rollback transaction on error', async () => {
      const request: ReplayRequest = {
        contract_id: 'contract-123',
        ledger: 1,
      };

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '10' }] }) // COUNT
        .mockRejectedValueOnce(new Error('Database error')); // Fetch fails

      await expect(service.replayEvents(request)).rejects.toThrow('Database error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
      
      const progress = service.getReplayProgress();
      expect(progress.isReplaying).toBe(false);
    });
  });

  describe('Progress Tracking', () => {
    it('should track replay progress accurately', async () => {
      const request: ReplayRequest = {
        contract_id: 'contract-123',
        ledger: 1,
      };

      const mockEvents = Array.from({ length: 50 }, (_, i) => ({
        event_id: `event-${i}`,
        contract_id: 'contract-123',
        ledger: 1,
        event_type: 'Transfer',
        event_data: { amount: 100 },
        block_height: 1000 + i,
        transaction_hash: `tx-${i}`,
      }));

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '50' }] }) // COUNT
        .mockResolvedValueOnce({ rows: mockEvents }) // Batch 1
        .mockResolvedValueOnce(undefined) // INSERT batch 1
        .mockResolvedValueOnce({ rows: [] }) // No more events
        .mockResolvedValueOnce(undefined); // COMMIT

      await service.replayEvents(request);

      const progress = service.getReplayProgress();
      expect(progress.totalRows).toBe(50);
      expect(progress.rowsReplayed).toBe(50);
      expect(progress.rowsRemaining).toBe(0);
      expect(progress.contractId).toBe('contract-123');
      expect(progress.ledger).toBe(1);
    });

    it('should calculate estimated completion time', async () => {
      const request: ReplayRequest = {
        contract_id: 'contract-123',
        ledger: 1,
      };

      const mockEvents = Array.from({ length: 100 }, (_, i) => ({
        event_id: `event-${i}`,
        contract_id: 'contract-123',
        ledger: 1,
        event_type: 'Transfer',
        event_data: { amount: 100 },
        block_height: 1000 + i,
        transaction_hash: `tx-${i}`,
      }));

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '200' }] }) // COUNT
        .mockResolvedValueOnce({ rows: mockEvents }) // Batch 1
        .mockResolvedValueOnce(undefined); // INSERT batch 1

      // Start replay but don't complete it
      const replayPromise = service.replayEvents(request);

      // Give it a moment to process first batch
      await new Promise(resolve => setTimeout(resolve, 10));

      const progress = service.getReplayProgress();
      expect(progress.startedAt).not.toBeNull();
      expect(progress.estimatedCompletion).not.toBeNull();

      // Complete the replay
      mockClient.query
        .mockResolvedValueOnce({ rows: mockEvents }) // Batch 2
        .mockResolvedValueOnce(undefined) // INSERT batch 2
        .mockResolvedValueOnce({ rows: [] }) // No more events
        .mockResolvedValueOnce(undefined); // COMMIT

      await replayPromise;
    });
  });

  describe('Block Range Filtering', () => {
    it('should filter events by from_block', async () => {
      const request: ReplayRequest = {
        contract_id: 'contract-123',
        ledger: 1,
        from_block: 1000,
      };

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // COUNT
        .mockResolvedValueOnce(undefined); // COMMIT

      await service.replayEvents(request);

      // Verify COUNT query includes from_block filter
      const countCall = mockClient.query.mock.calls.find((call: any) =>
        call[0].includes('COUNT(*)')
      );
      expect(countCall[0]).toContain('block_height >= $3');
      expect(countCall[1]).toContain(1000);
    });

    it('should filter events by to_block', async () => {
      const request: ReplayRequest = {
        contract_id: 'contract-123',
        ledger: 1,
        to_block: 2000,
      };

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // COUNT
        .mockResolvedValueOnce(undefined); // COMMIT

      await service.replayEvents(request);

      // Verify COUNT query includes to_block filter
      const countCall = mockClient.query.mock.calls.find((call: any) =>
        call[0].includes('COUNT(*)')
      );
      expect(countCall[0]).toContain('block_height <= $3');
      expect(countCall[1]).toContain(2000);
    });

    it('should filter events by both from_block and to_block', async () => {
      const request: ReplayRequest = {
        contract_id: 'contract-123',
        ledger: 1,
        from_block: 1000,
        to_block: 2000,
      };

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // COUNT
        .mockResolvedValueOnce(undefined); // COMMIT

      await service.replayEvents(request);

      // Verify COUNT query includes both filters
      const countCall = mockClient.query.mock.calls.find((call: any) =>
        call[0].includes('COUNT(*)')
      );
      expect(countCall[0]).toContain('block_height >= $3');
      expect(countCall[0]).toContain('block_height <= $4');
      expect(countCall[1]).toContain(1000);
      expect(countCall[1]).toContain(2000);
    });
  });

  describe('SQL Injection Prevention', () => {
    it('should use parameterized queries for all inputs', async () => {
      const request: ReplayRequest = {
        contract_id: "'; DROP TABLE contract_events; --",
        ledger: 1,
      };

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // COUNT
        .mockResolvedValueOnce(undefined); // COMMIT

      await service.replayEvents(request);

      // Verify all queries use parameterized values
      mockClient.query.mock.calls.forEach((call: any) => {
        if (call[0].includes('SELECT') || call[0].includes('INSERT')) {
          expect(call[1]).toBeDefined(); // Parameters array exists
          expect(Array.isArray(call[1])).toBe(true);
        }
      });
    });
  });

  describe('getReplayProgress', () => {
    it('should return current replay progress', () => {
      const progress = service.getReplayProgress();
      
      expect(progress).toHaveProperty('isReplaying');
      expect(progress).toHaveProperty('rowsReplayed');
      expect(progress).toHaveProperty('rowsRemaining');
      expect(progress).toHaveProperty('totalRows');
      expect(progress).toHaveProperty('estimatedCompletion');
      expect(progress).toHaveProperty('startedAt');
    });

    it('should return a copy of the state, not the original', () => {
      const progress1 = service.getReplayProgress();
      const progress2 = service.getReplayProgress();
      
      expect(progress1).not.toBe(progress2);
      expect(progress1).toEqual(progress2);
    });
  });
});
