import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLogger, initializeLogger } from './logger.js';

describe('logger config', () => {
  it('should initialize and get logger', () => {
    initializeLogger('info');
    const logger = getLogger();
    assert.ok(logger);
  });
});
