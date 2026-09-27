/**
 * Integration test for startup ordering with a slow dependency.
 *
 * This test validates the acceptance criteria:
 * - The listener starts only after required dependencies are ready.
 * - A dependency unavailable at startup does not cause a crash loop.
 * - No request is accepted before readiness.
 *
 * ## Scenario
 *
 * We simulate a slow dependency by:
 * 1. Creating an HTTP server that listens immediately
 * 2. Simulating startup probes (fast)
 * 3. Delaying pool/Redis/indexer initialization
 * 4. Attempting requests during the delay
 * 5. Verifying requests are rejected until markReady() is called
 * 6. Verifying requests are accepted after markReady()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import {
  _resetReadinessState,
  markDependenciesReady,
  markPoolReady,
  markRedisReady,
  markIndexerReady,
  markReady,
  isReady,
} from '../src/startup/readiness.js';

describe('Startup with Slow Dependency', () => {
  let app: Express;
  let server: http.Server;
  let port: number;

  beforeEach((context) => {
    _resetReadinessState();
    app = createApp();

    // Start the HTTP server on any available port
    server = http.createServer(app);
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        if (typeof address === 'object' && address !== null) {
          port = address.port;
        }
        resolve();
      });
    });
  });

  afterEach((context) => {
    _resetReadinessState();
    return new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it('should reject requests during dependency initialization', async () => {
    // Simulate startup probes completing quickly
    markDependenciesReady();

    // Requests should still be rejected (not yet ready)
    let res = await request(app).get('/');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unavailable');

    // Simulate pool initialization
    markPoolReady();

    res = await request(app).get('/');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unavailable');

    // Simulate Redis initialization
    markRedisReady();

    res = await request(app).get('/');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unavailable');

    // Simulate indexer initialization
    markIndexerReady();

    res = await request(app).get('/');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unavailable');
  });

  it('should accept requests after all dependencies are ready', async () => {
    // Simulate all dependency initialization
    markDependenciesReady();
    markPoolReady();
    markRedisReady();
    markIndexerReady();

    // Still not ready
    let res = await request(app).get('/');
    expect(res.status).toBe(503);
    expect(isReady()).toBe(false);

    // Mark as ready
    markReady();
    expect(isReady()).toBe(true);

    // Now requests should be accepted
    res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Fluxora API');
  });

  it('should not accept POST requests during startup', async () => {
    markDependenciesReady();

    // Try various request types
    let res = await request(app).post('/api/streams').send({ test: true });
    expect(res.status).toBe(503);

    res = await request(app).put('/some-endpoint').send({ test: true });
    expect(res.status).toBe(503);

    res = await request(app).delete('/some-endpoint');
    expect(res.status).toBe(503);

    // Only after ready
    markPoolReady();
    markRedisReady();
    markIndexerReady();
    markReady();

    res = await request(app).get('/');
    expect(res.status).toBe(200);
  });

  it('should handle rapid request bursts during startup', async () => {
    markDependenciesReady();

    // Simulate a burst of requests arriving immediately after server starts
    const promises = Array(10)
      .fill(null)
      .map(() => request(app).get('/'));

    const results = await Promise.all(promises);

    // All should be rejected
    for (const res of results) {
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unavailable');
    }

    // After readiness, same burst should succeed
    markPoolReady();
    markRedisReady();
    markIndexerReady();
    markReady();

    const successPromises = Array(10)
      .fill(null)
      .map(() => request(app).get('/'));

    const successResults = await Promise.all(successPromises);

    // All should succeed
    for (const res of successResults) {
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Fluxora API');
    }
  });

  it('should reject requests to different routes during startup', async () => {
    const routes = ['/', '/health', '/health/ready', '/metrics', '/api/streams'];

    for (const route of routes) {
      const res = await request(app).get(route);
      expect(res.status).toBe(503);
      expect(res.body.phase).toBeDefined();
    }
  });

  it('should maintain 503 status until all phases complete', async () => {
    // Verify each phase transition keeps requests blocked
    const phases = [
      { fn: () => markDependenciesReady(), name: 'DEPENDENCIES_READY' },
      { fn: () => markPoolReady(), name: 'POOL_READY' },
      { fn: () => markRedisReady(), name: 'REDIS_READY' },
      { fn: () => markIndexerReady(), name: 'INDEXER_READY' },
    ];

    for (const phase of phases) {
      phase.fn();

      const res = await request(app).get('/');
      expect(res.status).toBe(503);
      expect(res.body.phase).toBe(phase.name);
    }

    // Only after READY should status be 200
    markReady();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });

  it('should not crash when slow dependency takes time', async () => {
    // Simulate a slow dependency initialization that takes multiple seconds
    markDependenciesReady();

    // Requests every 100ms for 1 second
    const startTime = Date.now();
    const rejectedCount = { value: 0 };

    while (Date.now() - startTime < 1000) {
      const res = await request(app).get('/');
      if (res.status === 503) {
        rejectedCount.value++;
      }
      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Verify we got rejected at least 5 times during the delay
    expect(rejectedCount.value).toBeGreaterThanOrEqual(5);

    // Server should still be running and healthy
    expect(server.listening).toBe(true);

    // Now mark as ready and verify acceptance
    markPoolReady();
    markRedisReady();
    markIndexerReady();
    markReady();

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });

  it('should provide diagnostics in 503 response for debugging', async () => {
    markDependenciesReady();
    markPoolReady();

    const res = await request(app).get('/');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'unavailable',
      phase: 'POOL_READY',
      timestamp: expect.any(String),
      message: expect.any(String),
    });

    // Verify timestamp is ISO 8601
    const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    expect(res.body.timestamp).toMatch(iso8601Regex);

    // Verify message is helpful
    expect(res.body.message).toContain('starting up');
    expect(res.body.message).toContain('POOL_READY');
  });

  it('should accept traffic only after complete startup sequence', async () => {
    // Verify no requests accepted at any intermediate step
    const steps = [
      { fn: () => markDependenciesReady(), shouldReject: true },
      { fn: () => markPoolReady(), shouldReject: true },
      { fn: () => markRedisReady(), shouldReject: true },
      { fn: () => markIndexerReady(), shouldReject: true },
      { fn: () => markReady(), shouldReject: false },
    ];

    for (const step of steps) {
      step.fn();

      const res = await request(app).get('/');
      if (step.shouldReject) {
        expect(res.status).toBe(503);
        expect(isReady()).toBe(false);
      } else {
        expect(res.status).toBe(200);
        expect(isReady()).toBe(true);
      }
    }
  });

  it('should handle dependency-unavailable scenario without crash loop', async () => {
    // Simulate the scenario where a dependency fails and startup is delayed
    markDependenciesReady();

    // Even if we get stuck in a state (e.g., Redis unavailable),
    // the server should not crash and should continue rejecting requests gracefully
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get('/');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unavailable');

      // Add small delay
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Server should still be healthy
    expect(server.listening).toBe(true);

    // Verify we can still recover by completing startup
    markPoolReady();
    markRedisReady();
    markIndexerReady();
    markReady();

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });
});
