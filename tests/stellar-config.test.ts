import { validateConfig } from '../src/stellar/config';
import { RpcValidationError } from '../src/stellar/errors';
import { StellarRpcClientConfig } from '../src/stellar/types';

describe('validateConfig', () => {
  const validConfig: StellarRpcClientConfig = {
    endpoint: 'https://rpc.stellar.org',
    timeout: 5000,
    maxRetries: 3,
    initialBackoff: 100,
    maxBackoff: 5000,
    circuitBreakerThreshold: 5,
    circuitBreakerRecoveryTimeout: 30000
  };

  describe('valid configurations', () => {
    it('should accept valid configuration', () => {
      expect(() => validateConfig(validConfig)).not.toThrow();
    });

    it('should accept maxRetries of 0', () => {
      const config = { ...validConfig, maxRetries: 0 };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept maxBackoff equal to initialBackoff', () => {
      const config = { ...validConfig, initialBackoff: 1000, maxBackoff: 1000 };
      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('endpoint validation', () => {
    it('should throw when endpoint is empty string', () => {
      const config = { ...validConfig, endpoint: '' };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('endpoint must be a non-empty string');
    });

    it('should throw when endpoint is whitespace only', () => {
      const config = { ...validConfig, endpoint: '   ' };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('endpoint must be a non-empty string');
    });

    it('should throw when endpoint is missing', () => {
      const config = { ...validConfig, endpoint: undefined as any };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
    });
  });

  describe('timeout validation', () => {
    it('should throw when timeout is zero', () => {
      const config = { ...validConfig, timeout: 0 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('timeout must be a positive integer');
    });

    it('should throw when timeout is negative', () => {
      const config = { ...validConfig, timeout: -100 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('timeout must be a positive integer');
    });

    it('should throw when timeout is not an integer', () => {
      const config = { ...validConfig, timeout: 100.5 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('timeout must be a positive integer');
    });
  });

  describe('maxRetries validation', () => {
    it('should throw when maxRetries is negative', () => {
      const config = { ...validConfig, maxRetries: -1 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('maxRetries must be a non-negative integer');
    });

    it('should throw when maxRetries is not an integer', () => {
      const config = { ...validConfig, maxRetries: 3.5 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('maxRetries must be a non-negative integer');
    });
  });

  describe('backoff validation', () => {
    it('should throw when initialBackoff is zero', () => {
      const config = { ...validConfig, initialBackoff: 0 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('initialBackoff must be a positive integer');
    });

    it('should throw when initialBackoff is negative', () => {
      const config = { ...validConfig, initialBackoff: -100 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('initialBackoff must be a positive integer');
    });

    it('should throw when initialBackoff is not an integer', () => {
      const config = { ...validConfig, initialBackoff: 100.5 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('initialBackoff must be a positive integer');
    });

    it('should throw when maxBackoff is zero', () => {
      const config = { ...validConfig, maxBackoff: 0 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('maxBackoff must be a positive integer');
    });

    it('should throw when maxBackoff is negative', () => {
      const config = { ...validConfig, maxBackoff: -1000 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('maxBackoff must be a positive integer');
    });

    it('should throw when maxBackoff is not an integer', () => {
      const config = { ...validConfig, maxBackoff: 5000.5 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('maxBackoff must be a positive integer');
    });

    it('should throw when maxBackoff is less than initialBackoff', () => {
      const config = { ...validConfig, initialBackoff: 5000, maxBackoff: 1000 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('maxBackoff (1000) must be >= initialBackoff (5000)');
    });
  });

  describe('circuit breaker validation', () => {
    it('should throw when circuitBreakerThreshold is zero', () => {
      const config = { ...validConfig, circuitBreakerThreshold: 0 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('circuitBreakerThreshold must be a positive integer');
    });

    it('should throw when circuitBreakerThreshold is negative', () => {
      const config = { ...validConfig, circuitBreakerThreshold: -5 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('circuitBreakerThreshold must be a positive integer');
    });

    it('should throw when circuitBreakerThreshold is not an integer', () => {
      const config = { ...validConfig, circuitBreakerThreshold: 5.5 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('circuitBreakerThreshold must be a positive integer');
    });

    it('should throw when circuitBreakerRecoveryTimeout is zero', () => {
      const config = { ...validConfig, circuitBreakerRecoveryTimeout: 0 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('circuitBreakerRecoveryTimeout must be a positive integer');
    });

    it('should throw when circuitBreakerRecoveryTimeout is negative', () => {
      const config = { ...validConfig, circuitBreakerRecoveryTimeout: -30000 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('circuitBreakerRecoveryTimeout must be a positive integer');
    });

    it('should throw when circuitBreakerRecoveryTimeout is not an integer', () => {
      const config = { ...validConfig, circuitBreakerRecoveryTimeout: 30000.5 };
      expect(() => validateConfig(config)).toThrow(RpcValidationError);
      expect(() => validateConfig(config)).toThrow('circuitBreakerRecoveryTimeout must be a positive integer');
    });
  });

  describe('error details', () => {
    it('should include field name in validation error', () => {
      const config = { ...validConfig, timeout: -100 };
      try {
        validateConfig(config);
        fail('Expected validation error');
      } catch (error) {
        expect(error).toBeInstanceOf(RpcValidationError);
        expect((error as RpcValidationError).field).toBe('timeout');
      }
    });

    it('should include error code in validation error', () => {
      const config = { ...validConfig, maxRetries: -1 };
      try {
        validateConfig(config);
        fail('Expected validation error');
      } catch (error) {
        expect(error).toBeInstanceOf(RpcValidationError);
        expect((error as RpcValidationError).code).toBe('RPC_VALIDATION_ERROR');
      }
    });
  });
});
