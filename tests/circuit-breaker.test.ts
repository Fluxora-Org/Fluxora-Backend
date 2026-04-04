import { CircuitBreaker } from '../src/stellar/circuit-breaker';
import { CircuitState } from '../src/stellar/types';

describe('CircuitBreaker', () => {
  describe('State Transitions', () => {
    it('should start in CLOSED state', () => {
      const breaker = new CircuitBreaker(3, 1000);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should transition from CLOSED to OPEN when threshold exceeded', () => {
      const breaker = new CircuitBreaker(3, 1000);

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should transition from OPEN to HALF_OPEN after recovery timeout', (done) => {
      const breaker = new CircuitBreaker(2, 100);

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      setTimeout(() => {
        expect(breaker.canExecute()).toBe(true);
        expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
        done();
      }, 150);
    });

    it('should transition from HALF_OPEN to CLOSED on success', () => {
      const breaker = new CircuitBreaker(2, 100);

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Manually transition to HALF_OPEN
      breaker['state'] = CircuitState.HALF_OPEN;

      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should transition from HALF_OPEN to OPEN on failure', () => {
      const breaker = new CircuitBreaker(2, 100);

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Manually transition to HALF_OPEN
      breaker['state'] = CircuitState.HALF_OPEN;

      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('canExecute', () => {
    it('should allow requests when circuit is CLOSED', () => {
      const breaker = new CircuitBreaker(3, 1000);
      expect(breaker.canExecute()).toBe(true);
    });

    it('should reject requests when circuit is OPEN and timeout not elapsed', () => {
      const breaker = new CircuitBreaker(2, 1000);

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
      expect(breaker.canExecute()).toBe(false);
    });

    it('should allow probe request when circuit is HALF_OPEN', () => {
      const breaker = new CircuitBreaker(2, 100);

      breaker.recordFailure();
      breaker.recordFailure();
      breaker['state'] = CircuitState.HALF_OPEN;

      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe('recordSuccess', () => {
    it('should reset failure count on success', () => {
      const breaker = new CircuitBreaker(3, 1000);

      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();

      // Should not open circuit after 2 more failures since count was reset
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should transition from HALF_OPEN to CLOSED', () => {
      const breaker = new CircuitBreaker(2, 100);

      breaker.recordFailure();
      breaker.recordFailure();
      breaker['state'] = CircuitState.HALF_OPEN;

      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('recordFailure', () => {
    it('should increment consecutive failure count', () => {
      const breaker = new CircuitBreaker(3, 1000);

      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should track lastFailureTime for recovery timeout', (done) => {
      const breaker = new CircuitBreaker(2, 100);

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
      expect(breaker.canExecute()).toBe(false);

      setTimeout(() => {
        expect(breaker.canExecute()).toBe(true);
        done();
      }, 150);
    });

    it('should transition from HALF_OPEN to OPEN on failure', () => {
      const breaker = new CircuitBreaker(2, 100);

      breaker['state'] = CircuitState.HALF_OPEN;
      breaker.recordFailure();

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('getState', () => {
    it('should return current circuit state', () => {
      const breaker = new CircuitBreaker(2, 1000);

      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });
});
