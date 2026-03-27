import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HealthCheckManager } from './health.js';

describe('health config', () => {
  it('should create HealthCheckManager', () => {
    const manager = new HealthCheckManager();
    assert.ok(manager);
  });
});
