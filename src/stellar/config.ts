import { StellarRpcClientConfig } from './types.js';
import { RpcValidationError } from './errors.js';

/**
 * Validates StellarRpcClientConfig and throws descriptive errors on validation failure
 * 
 * @param config - Configuration object to validate
 * @throws {RpcValidationError} When validation fails
 */
export function validateConfig(config: StellarRpcClientConfig): void {
  // Validate endpoint
  if (!config.endpoint || typeof config.endpoint !== 'string' || config.endpoint.trim() === '') {
    throw new RpcValidationError(
      'Configuration validation failed: endpoint must be a non-empty string',
      'endpoint'
    );
  }

  // Validate timeout is positive integer
  if (!Number.isInteger(config.timeout) || config.timeout <= 0) {
    throw new RpcValidationError(
      `Configuration validation failed: timeout must be a positive integer, got ${config.timeout}`,
      'timeout'
    );
  }

  // Validate maxRetries is non-negative integer
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0) {
    throw new RpcValidationError(
      `Configuration validation failed: maxRetries must be a non-negative integer, got ${config.maxRetries}`,
      'maxRetries'
    );
  }

  // Validate initialBackoff is positive integer
  if (!Number.isInteger(config.initialBackoff) || config.initialBackoff <= 0) {
    throw new RpcValidationError(
      `Configuration validation failed: initialBackoff must be a positive integer, got ${config.initialBackoff}`,
      'initialBackoff'
    );
  }

  // Validate maxBackoff is positive integer
  if (!Number.isInteger(config.maxBackoff) || config.maxBackoff <= 0) {
    throw new RpcValidationError(
      `Configuration validation failed: maxBackoff must be a positive integer, got ${config.maxBackoff}`,
      'maxBackoff'
    );
  }

  // Validate maxBackoff >= initialBackoff
  if (config.maxBackoff < config.initialBackoff) {
    throw new RpcValidationError(
      `Configuration validation failed: maxBackoff (${config.maxBackoff}) must be >= initialBackoff (${config.initialBackoff})`,
      'maxBackoff'
    );
  }

  // Validate circuitBreakerThreshold is positive integer
  if (!Number.isInteger(config.circuitBreakerThreshold) || config.circuitBreakerThreshold <= 0) {
    throw new RpcValidationError(
      `Configuration validation failed: circuitBreakerThreshold must be a positive integer, got ${config.circuitBreakerThreshold}`,
      'circuitBreakerThreshold'
    );
  }

  // Validate circuitBreakerRecoveryTimeout is positive integer
  if (!Number.isInteger(config.circuitBreakerRecoveryTimeout) || config.circuitBreakerRecoveryTimeout <= 0) {
    throw new RpcValidationError(
      `Configuration validation failed: circuitBreakerRecoveryTimeout must be a positive integer, got ${config.circuitBreakerRecoveryTimeout}`,
      'circuitBreakerRecoveryTimeout'
    );
  }
}
