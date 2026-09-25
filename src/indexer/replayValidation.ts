// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
import { ReplayRequest } from '../types.js';

/**
 * Validate replay request parameters.
 *
 * All validation runs before any database access — bad parameters are
 * rejected cheaply and do not waste pool connections.
 *
 * @throws {Error} For any invalid parameter.
 */
export function validateReplayRequest(request: ReplayRequest, maxRangeBlocks: number): void {
  if (!request.contract_id || typeof request.contract_id !== 'string') {
    throw new Error('Invalid contract_id');
  }
  if (typeof request.ledger !== 'number' || request.ledger < 0) {
    throw new Error('Invalid ledger');
  }
  if (
    request.from_block !== undefined &&
    (typeof request.from_block !== 'number' || request.from_block < 0)
  ) {
    throw new Error('Invalid from_block');
  }
  if (
    request.to_block !== undefined &&
    (typeof request.to_block !== 'number' || request.to_block < 0)
  ) {
    throw new Error('Invalid to_block');
  }
  if (
    request.from_block !== undefined &&
    request.to_block !== undefined &&
    request.from_block > request.to_block
  ) {
    throw new Error('from_block must be less than or equal to to_block');
  }

  // Guard against unbounded ranges that could run indefinitely.
  if (
    maxRangeBlocks > 0 &&
    request.from_block !== undefined &&
    request.to_block !== undefined
  ) {
    const range = request.to_block - request.from_block;
    if (range > maxRangeBlocks) {
      throw new Error(
        `Block range ${range} exceeds the maximum allowed range of ${maxRangeBlocks}. ` +
          'Reduce the range or increase INDEXER_MAX_REPLAY_RANGE_BLOCKS.',
      );
    }
  }
}
