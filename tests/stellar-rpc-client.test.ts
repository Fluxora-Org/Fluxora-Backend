import { StellarRpcClient } from '../src/stellar/stellar-rpc-client.js';
import { StellarRpcClientConfig, EventFilters, EventsResponse, HealthCheckResult, CircuitState } from '../src/stellar/types.js';
import { RpcValidationError, RpcTimeoutError, RpcCircuitOpenError } from '../src/stellar/errors.js';

describe('StellarRpcClient - getEvents', () => {
  let client: StellarRpcClient;
  let config: StellarRpcClientConfig;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    // Setup default config
    config = {
      endpoint: 'https://stellar-rpc.example.com',
      timeout: 5000,
      maxRetries: 3,
      initialBackoff: 100,
      maxBackoff: 1000,
      circuitBreakerThreshold: 5,
      circuitBreakerRecoveryTimeout: 10000,
    };

    // Mock global fetch
    mockFetch = jest.fn();
    global.fetch = mockFetch;

    client = new StellarRpcClient(config);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Filter Validation', () => {
    it('should accept valid filters with all fields', async () => {
      const filters: EventFilters = {
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
        topics: ['topic1', 'topic2'],
        startLedger: 100,
        endLedger: 200,
      };

      const mockResponse: EventsResponse = {
        events: [],
        latestLedger: 200,
      };

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ result: mockResponse }),
        status: 200,
      });

      const result = await client.getEvents(filters);
      expect(result).toEqual(mockResponse);
    });

    it('should accept filters with only contractId', async () => {
      const filters: EventFilters = {
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      };

      const mockResponse: EventsResponse = {
        events: [],
        latestLedger: 100,
      };

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ result: mockResponse }),
        status: 200,
      });

      const result = await client.getEvents(filters);
      expect(result).toEqual(mockResponse);
    });

    it('should accept filters with only ledger range', async () => {
      const filters: EventFilters = {
        startLedger: 50,
        endLedger: 100,
      };

      const mockResponse: EventsResponse = {
        events: [],
        latestLedger: 100,
      };

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ result: mockResponse }),
        status: 200,
      });

      const result = await client.getEvents(filters);
      expect(result).toEqual(mockResponse);
    });

    it('should throw validation error when startLedger > endLedger', async () => {
      const filters: EventFilters = {
        startLedger: 200,
        endLedger: 100,
      };

      await expect(client.getEvents(filters)).rejects.toThrow(RpcValidationError);
      await expect(client.getEvents(filters)).rejects.toThrow(
        'startLedger must be less than or equal to endLedger'
      );
    });

    it('should throw validation error for non-integer startLedger', async () => {
      const filters: EventFilters = {
        startLedger: 100.5,
      };

      await expect(client.getEvents(filters)).rejects.toThrow(RpcValidationError);
      await expect(client.getEvents(filters)).rejects.toThrow('startLedger must be an integer');
    });

    it('should throw validation error for negative startLedger', async () => {
      const filters: EventFilters = {
        startLedger: -10,
      };

      await expect(client.getEvents(filters)).rejects.toThrow(RpcValidationError);
      await expect(client.getEvents(filters)).rejects.toThrow(
        'startLedger must be a positive integer'
      );
    });

    it('should throw validation error for zero startLedger', async () => {
      const filters: EventFilters = {
        startLedger: 0,
      };

      await expect(client.getEvents(filters)).rejects.toThrow(RpcValidationError);
      await expect(client.getEvents(filters)).rejects.toThrow(
        'startLedger must be a positive integer'
      );
    });

    it('should throw validation error for non-integer endLedger', async () => {
      const filters: EventFilters = {
        endLedger: 200.7,
      };

      await expect(client.getEvents(filters)).rejects.toThrow(RpcValidationError);
      await expect(client.getEvents(filters)).rejects.toThrow('endLedger must be an integer');
    });

    it('should throw validation error for negative endLedger', async () => {
      const filters: EventFilters = {
        endLedger: -5,
      };

      await expect(client.getEvents(filters)).rejects.toThrow(RpcValidationError);
      await expect(client.getEvents(filters)).rejects.toThrow(
        'endLedger must be a positive integer'
      );
    });

    it('should throw validation error for empty contractId', async () => {
      const filters: EventFilters = {
        contractId: '',
      };

      await expect(client.getEvents(filters)).rejects.toThrow(RpcValidationError);
      await expect(client.getEvents(filters)).rejects.toThrow(
        'contractId must be a non-empty string'
      );
    });

    it('should throw validation error for whitespace-only contractId', async () => {
      const filters: EventFilters = {
        contractId: '   ',
      };

      await expect(client.getEvents(filters)).rejects.toThrow(RpcValidationError);
      await expect(client.getEvents(filters)).rejects.toThrow(
        'contractId must be a non-empty string'
      );
    });

    it('should throw validation error for non-array topics', async () => {
      const filters = {
        topics: 'not-an-array',
      } as unknown as EventFilters;

      await expect(client.getEvents(filters)).rejects.toThrow(RpcValidationError);
      await expect(client.getEvents(filters)).rejects.toThrow('topics must be an array');
    });

    it('should throw validation error for non-string topic in array', async () => {
      const filters = {
        topics: ['valid', 123, 'another'],
      } as unknown as EventFilters;

      await expect(client.getEvents(filters)).rejects.toThrow(RpcValidationError);
      await expect(client.getEvents(filters)).rejects.toThrow('Each topic must be a string');
    });
  });

  describe('Response Validation', () => {
    it('should accept valid response with empty events array', async () => {
      const filters: EventFilters = {
        startLedger: 100,
      };

      const mockResponse: EventsResponse = {
        events: [],
        latestLedger: 150,
      };

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ result: mockResponse }),
        status: 200,
      });

      const result = await client.getEvents(filters);
      expect(result).toEqual(mockResponse);
      expect(result.events).toHaveLength(0);
      expect(result.latestLedger).toBe(150);
    });

    it('should accept valid response with populated events', async () => {
      const filters: EventFilters = {
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      };

      const mockResponse: EventsResponse = {
        events: [
          {
            type: 'contract',
            ledger: 100,
            contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
            topics: ['transfer'],
            data: { amount: '1000' },
          },
          {
            type: 'contract',
            ledger: 101,
            contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
            topics: ['mint'],
            data: { recipient: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM' },
          },
        ],
        latestLedger: 200,
      };

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ result: mockResponse }),
        status: 200,
      });

      const result = await client.getEvents(filters);
      expect(result).toEqual(mockResponse);
      expect(result.events).toHaveLength(2);
      expect(result.events[0].type).toBe('contract');
      expect(result.events[1].ledger).toBe(101);
    });
  });

  describe('Request Execution', () => {
    it('should build correct RPC request payload', async () => {
      const filters: EventFilters = {
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
        topics: ['transfer'],
        startLedger: 100,
        endLedger: 200,
      };

      const mockResponse: EventsResponse = {
        events: [],
        latestLedger: 200,
      };

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ result: mockResponse }),
        status: 200,
      });

      await client.getEvents(filters);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe(config.endpoint);

      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody.method).toBe('getEvents');
      expect(requestBody.params).toEqual({ filters });
    });

    it('should pass correlationId from options', async () => {
      const filters: EventFilters = {
        startLedger: 100,
      };

      const correlationId = 'test-correlation-id-123';

      const mockResponse: EventsResponse = {
        events: [],
        latestLedger: 100,
      };

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ result: mockResponse }),
        status: 200,
      });

      await client.getEvents(filters, { correlationId });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.id).toBe(correlationId);
    });
  });
});

describe('StellarRpcClient - healthCheck', () => {
  let client: StellarRpcClient;
  let config: StellarRpcClientConfig;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    // Setup default config
    config = {
      endpoint: 'https://stellar-rpc.example.com',
      timeout: 5000,
      maxRetries: 3,
      initialBackoff: 100,
      maxBackoff: 1000,
      circuitBreakerThreshold: 5,
      circuitBreakerRecoveryTimeout: 10000,
    };

    // Mock global fetch
    mockFetch = jest.fn();
    global.fetch = mockFetch;

    client = new StellarRpcClient(config);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Successful Health Check', () => {
    it('should return healthy status on successful response', async () => {
      const mockResponse = {
        sequence: 1,
        hash: 'abc123',
        transactionCount: 0,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: mockResponse }),
      });

      const result: HealthCheckResult = await client.healthCheck();

      expect(result.healthy).toBe(true);
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
      expect(result.circuitState).toBe(CircuitState.CLOSED);
      expect(result.error).toBeUndefined();
    });

    it('should measure response time accurately', async () => {
      const mockResponse = {
        sequence: 1,
        hash: 'abc123',
        transactionCount: 0,
      };

      // Simulate a delay
      mockFetch.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: mockResponse }),
        };
      });

      const result: HealthCheckResult = await client.healthCheck();

      expect(result.healthy).toBe(true);
      expect(result.responseTime).toBeGreaterThanOrEqual(50);
      expect(result.responseTime).toBeLessThan(200);
    });

    it('should send getLedger request with sequence 1', async () => {
      const mockResponse = {
        sequence: 1,
        hash: 'abc123',
        transactionCount: 0,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: mockResponse }),
      });

      await client.healthCheck();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe(config.endpoint);

      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody.method).toBe('getLedger');
      expect(requestBody.params).toEqual({ sequence: 1 });
      expect(requestBody.jsonrpc).toBe('2.0');
    });

    it('should include circuit breaker state in result', async () => {
      const mockResponse = {
        sequence: 1,
        hash: 'abc123',
        transactionCount: 0,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: mockResponse }),
      });

      const result: HealthCheckResult = await client.healthCheck();

      expect(result.circuitState).toBeDefined();
      expect([CircuitState.CLOSED, CircuitState.OPEN, CircuitState.HALF_OPEN]).toContain(result.circuitState);
    });
  });

  describe('Failed Health Check', () => {
    it('should return unhealthy status on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal Server Error' }),
      });

      const result: HealthCheckResult = await client.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
      expect(result.circuitState).toBe(CircuitState.CLOSED);
      expect(result.error).toContain('Health check failed with status 500');
    });

    it('should return unhealthy status on timeout', async () => {
      // Use a shorter timeout for this test
      const shortTimeoutConfig = { ...config, timeout: 100 };
      const shortTimeoutClient = new StellarRpcClient(shortTimeoutConfig);

      // Mock fetch to throw AbortError when signal is aborted
      mockFetch.mockImplementation((_url, options) => {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal as AbortSignal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const abortError = new Error('The operation was aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }
          // Never resolve - let the timeout trigger the abort
        });
      });

      const result: HealthCheckResult = await shortTimeoutClient.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.responseTime).toBeGreaterThanOrEqual(shortTimeoutConfig.timeout);
      expect(result.error).toBeDefined();
    });

    it('should return unhealthy status on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result: HealthCheckResult = await client.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
      expect(result.error).toBe('Network error');
    });

    it('should return unhealthy status on JSON parse error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      const result: HealthCheckResult = await client.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.error).toBe('Invalid JSON');
    });

    it('should handle 404 Not Found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not Found' }),
      });

      const result: HealthCheckResult = await client.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Health check failed with status 404');
    });

    it('should handle 503 Service Unavailable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Service Unavailable' }),
      });

      const result: HealthCheckResult = await client.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Health check failed with status 503');
    });
  });

  describe('Circuit Breaker Integration', () => {
    it('should not affect circuit breaker on health check failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result: HealthCheckResult = await client.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.circuitState).toBe(CircuitState.CLOSED);

      // Verify circuit breaker is still closed by making a regular request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: { sequence: 1, hash: 'abc', transactionCount: 0 } }),
      });

      // This should not throw circuit open error
      await expect(client.getLedger(1)).resolves.toBeDefined();
    });

    it('should reflect circuit breaker state when circuit is open', async () => {
      // Trigger circuit breaker by causing multiple failures
      mockFetch.mockRejectedValue(new Error('Network error'));

      // Cause enough failures to open circuit
      for (let i = 0; i < config.circuitBreakerThreshold; i++) {
        try {
          await client.getLedger(1);
        } catch (e) {
          // Expected to fail
        }
      }

      // Now perform health check
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: { sequence: 1, hash: 'abc', transactionCount: 0 } }),
      });

      const result: HealthCheckResult = await client.healthCheck();

      // Health check should still work and report circuit state
      expect(result.circuitState).toBe(CircuitState.OPEN);
    });
  });

  describe('Request Format', () => {
    it('should use correct HTTP method and headers', async () => {
      const mockResponse = {
        sequence: 1,
        hash: 'abc123',
        transactionCount: 0,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: mockResponse }),
      });

      await client.healthCheck();

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].method).toBe('POST');
      expect(callArgs[1].headers).toEqual({
        'Content-Type': 'application/json',
      });
    });

    it('should generate unique correlation ID for each health check', async () => {
      const mockResponse = {
        sequence: 1,
        hash: 'abc123',
        transactionCount: 0,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ result: mockResponse }),
      });

      await client.healthCheck();
      const firstCallId = JSON.parse(mockFetch.mock.calls[0][1].body).id;

      await client.healthCheck();
      const secondCallId = JSON.parse(mockFetch.mock.calls[1][1].body).id;

      expect(firstCallId).not.toBe(secondCallId);
      expect(typeof firstCallId).toBe('string');
      expect(typeof secondCallId).toBe('string');
    });
  });
});
