import assert from 'node:assert/strict';

import {
  defaultChainStatusForStartTime,
  mapChainStatusToApiStatus,
} from './status.js';

assert.deepEqual(
  mapChainStatusToApiStatus('pending'),
  {
    chainStatus: 'pending',
    status: 'scheduled',
    terminal: false,
  },
);

assert.deepEqual(
  mapChainStatusToApiStatus('depleted'),
  {
    chainStatus: 'depleted',
    status: 'completed',
    terminal: true,
    statusReason: 'depleted',
  },
);

assert.equal(
  defaultChainStatusForStartTime(2_000_000_000, 1_900_000_000),
  'pending',
);

assert.equal(
  defaultChainStatusForStartTime(1_800_000_000, 1_900_000_000),
  'active',
);

console.log('Stream status mapping assertions passed.');
