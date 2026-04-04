import { CircuitState } from './types.js';
import * as logger from '../utils/logger.js';

/**
 * CircuitBreaker implements the circuit breaker pattern to prevent cascading failures
 * States: CLOSED (normal), OPEN (failing), HALF_OPEN (testing recovery)
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures: number = 0;
  private lastFailureTime: number = 0;

  constructor(
    private readonly threshold: number,
    private readonly recoveryTimeout: number
  ) {}

  /**
   * Checks if a request can be executed based on current circuit state
   * @returns true if request should be allowed, false if circuit is open
   */
  canExecute(): boolean {
    // If circuit is closed, allow all requests
    if (this.state === CircuitState.CLOSED) {
      return true;
    }

    // If circuit is open, check if recovery timeout has elapsed
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      const timeSinceLastFailure = now - this.lastFailureTime;

      // If recovery timeout has elapsed, transition to HALF_OPEN
      if (timeSinceLastFailure >= this.recoveryTimeout) {
        const previousState = this.state;
        this.state = CircuitState.HALF_OPEN;
        
        // Log state transition
        logger.warn('Circuit breaker state transition', {
          previousState,
          newState: this.state,
          reason: 'Recovery timeout elapsed, attempting probe request',
        });

        return true;
      }

      // Circuit is still open, reject request
      return false;
    }

    // If circuit is HALF_OPEN, allow single probe request
    if (this.state === CircuitState.HALF_OPEN) {
      return true;
    }

    return false;
  }

  /**
   * Records a successful request and resets failure count
   * Transitions from HALF_OPEN to CLOSED on success
   */
  recordSuccess(): void {
    // Reset failure count
    this.consecutiveFailures = 0;

    // If we were in HALF_OPEN state, transition to CLOSED
    if (this.state === CircuitState.HALF_OPEN) {
      const previousState = this.state;
      this.state = CircuitState.CLOSED;
      
      // Log state transition
      logger.warn('Circuit breaker state transition', {
        previousState,
        newState: this.state,
        reason: 'Probe request succeeded, circuit recovered',
      });
    }
  }

  /**
   * Records a failed request and increments failure counter
   * Transitions to OPEN when threshold is exceeded
   */
  recordFailure(): void {
    // Increment consecutive failure count
    this.consecutiveFailures++;

    // Record timestamp of failure
    this.lastFailureTime = Date.now();

    // If in HALF_OPEN state, any failure transitions back to OPEN
    if (this.state === CircuitState.HALF_OPEN) {
      const previousState = this.state;
      this.state = CircuitState.OPEN;
      
      // Log state transition
      logger.warn('Circuit breaker state transition', {
        previousState,
        newState: this.state,
        reason: 'Probe request failed, circuit reopened',
      });

      return;
    }

    // If in CLOSED state, check if threshold is exceeded
    if (this.state === CircuitState.CLOSED) {
      if (this.consecutiveFailures >= this.threshold) {
        const previousState = this.state;
        this.state = CircuitState.OPEN;
        
        // Log state transition
        logger.warn('Circuit breaker state transition', {
          previousState,
          newState: this.state,
          reason: `Failure threshold exceeded (${this.consecutiveFailures} failures)`,
        });
      }
    }
  }

  /**
   * Returns the current circuit breaker state for observability
   * @returns Current CircuitState
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Returns the current consecutive failure count for observability
   * @returns Current consecutive failure count
   */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}
