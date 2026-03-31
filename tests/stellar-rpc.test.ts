import { vi as jest } from 'vitest';
import { StellarRpcClient } from '../src/lib/stellar-rpc.js';

describe('StellarRpcClient', () => {
  let client: StellarRpcClient;
  let mockServerInstance: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Explicitly create mock methods
    mockServerInstance = {
      getLatestLedger: jest.fn(),
      getHealth: jest.fn(),
    };

    // Use Dependency Injection (passing the mock server to the constructor)
    client = new StellarRpcClient(mockServerInstance);
  });

  describe('withTimeout', () => {
    it('should resolve if function completes within timeout', async () => {
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue('success');
      const result = await client.withTimeout(fn, 1000);
      expect(result).toBe('success');
    });

    it('should reject if function exceeds timeout', async () => {
      // Use a function that never resolves to test timeout
      const fn = () => new Promise<string>(() => {});
      const promise = client.withTimeout(fn, 10);
      await expect(promise).rejects.toThrow('Operation timed out after 10ms');
    });
  });

  describe('withRetry', () => {
    it('should resolve on first attempt if successful', async () => {
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue('success');
      const result = await client.withRetry(fn, 3, 1);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and resolve if subsequent attempt succeeds', async () => {
      const fn = jest.fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue('success');

      const result = await client.withRetry(fn, 3, 1);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw after max retries', async () => {
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('constant fail'));
      await expect(client.withRetry(fn, 2, 1)).rejects.toThrow('constant fail');
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });
  });

  describe('getLatestLedger', () => {
    it('should call getLatestLedger and return result', async () => {
      const mockResult = { id: 'ledger-mock-id' };
      mockServerInstance.getLatestLedger.mockResolvedValue(mockResult);

      const result = await client.getLatestLedger();
      expect(result).toEqual(mockResult);
      expect(mockServerInstance.getLatestLedger).toHaveBeenCalled();
    });
  });

  describe('getHealth', () => {
    it('should call getHealth and return result', async () => {
      const mockResult = { status: 'healthy' };
      mockServerInstance.getHealth.mockResolvedValue(mockResult);

      const result = await client.getHealth();
      expect(result).toEqual(mockResult);
      expect(mockServerInstance.getHealth).toHaveBeenCalled();
    });
  });
});
