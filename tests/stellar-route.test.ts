/**
 * Tests for Stellar RPC route demonstrating client usage
 */

import request from 'supertest';
import { app } from '../src/app.js';

describe('GET /api/stellar/accounts/:accountId', () => {
  it('returns 400 for invalid account ID format', async () => {
    const response = await request(app)
      .get('/api/stellar/accounts/invalid')
      .expect(400);

    expect(response.body.error).toBeDefined();
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.requestId).toBeDefined();
  });

  it('includes correlation ID in response', async () => {
    const correlationId = 'test-correlation-id';
    
    // Use an invalid account ID that will fail validation before making RPC call
    const response = await request(app)
      .get('/api/stellar/accounts/GAAAA')
      .set('x-correlation-id', correlationId)
      .expect(400);

    expect(response.body.error.requestId).toBe(correlationId);
  });

  it('returns 400 for account ID with wrong length', async () => {
    const response = await request(app)
      .get('/api/stellar/accounts/GAAAA')
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('56 characters');
  });

  it('returns 400 for account ID not starting with G', async () => {
    const response = await request(app)
      .get('/api/stellar/accounts/XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('start with G');
  });

  it('returns 400 for account ID with invalid characters', async () => {
    // Create a 56-character string with invalid characters (not base32)
    const invalidAccountId = 'G' + '!'.repeat(55);
    
    const response = await request(app)
      .get(`/api/stellar/accounts/${invalidAccountId}`)
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('base32');
  });
});

describe('GET /api/stellar/health', () => {
  it('returns health check result', async () => {
    const response = await request(app)
      .get('/api/stellar/health');

    expect(response.body).toHaveProperty('healthy');
    expect(response.body).toHaveProperty('responseTime');
    expect(response.body).toHaveProperty('circuitState');
    expect(response.body).toHaveProperty('requestId');
    expect(typeof response.body.healthy).toBe('boolean');
    expect(typeof response.body.responseTime).toBe('number');
  }, 60000); // 60 second timeout for real network call

  it('includes correlation ID in response', async () => {
    const correlationId = 'health-check-id';
    
    const response = await request(app)
      .get('/api/stellar/health')
      .set('x-correlation-id', correlationId);

    expect(response.body.requestId).toBe(correlationId);
  });
});

describe('GET /api/stellar/metrics', () => {
  it('returns metrics snapshot', async () => {
    const response = await request(app)
      .get('/api/stellar/metrics')
      .expect(200);

    expect(response.body).toHaveProperty('metrics');
    expect(response.body).toHaveProperty('requestId');
    expect(response.body.metrics).toHaveProperty('totalRequests');
    expect(response.body.metrics).toHaveProperty('successfulRequests');
    expect(response.body.metrics).toHaveProperty('failedRequests');
    expect(response.body.metrics).toHaveProperty('circuitBreakerState');
  });

  it('includes correlation ID in response', async () => {
    const correlationId = 'metrics-check-id';
    
    const response = await request(app)
      .get('/api/stellar/metrics')
      .set('x-correlation-id', correlationId)
      .expect(200);

    expect(response.body.requestId).toBe(correlationId);
  });
});
