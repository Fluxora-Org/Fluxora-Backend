import assert from 'node:assert/strict';

import { assessIndexerHealth } from './stall.js';

function testNotConfigured() {
  const health = assessIndexerHealth({
    enabled: false,
  });

  assert.equal(health.status, 'not_configured');
  assert.equal(health.clientImpact, 'none');
  assert.equal(health.operatorAction, 'none');
}

function testHealthy() {
  const health = assessIndexerHealth({
    enabled: true,
    lastSuccessfulSyncAt: '2026-03-25T20:00:00.000Z',
    now: '2026-03-25T20:03:00.000Z',
    stallThresholdMs: 5 * 60 * 1000,
  });

  assert.equal(health.status, 'healthy');
  assert.equal(health.stalled, false);
  assert.equal(health.clientImpact, 'none');
}

function testStalled() {
  const health = assessIndexerHealth({
    enabled: true,
    lastSuccessfulSyncAt: '2026-03-25T20:00:00.000Z',
    now: '2026-03-25T20:06:00.000Z',
    stallThresholdMs: 5 * 60 * 1000,
  });

  assert.equal(health.status, 'stalled');
  assert.equal(health.stalled, true);
  assert.equal(health.clientImpact, 'stale_chain_state');
  assert.equal(health.operatorAction, 'page');
}

testNotConfigured();
testHealthy();
testStalled();

console.log('Indexer freshness assertions passed.');
