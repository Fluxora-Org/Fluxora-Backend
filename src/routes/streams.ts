import { Router } from 'express';
import type { Stream } from '../serialization/stream.js';
import { registerReadRoutes } from './streams/read.js';
import { registerWriteRoutes } from './streams/write.js';
import { registerSseRoutes } from './streams/sse.js';
import { registerLongPollRoutes } from './streams/longPoll.js';

export type { Stream } from '../serialization/stream.js';
export { STREAMS_ENHANCED_RESPONSE_FLAG } from './streams/read.js';
export {
  enforceStreamScope,
  fingerprintInput,
  getFeatureFlagRequesterId,
  parseLastEventIdHeader,
} from './streams/guards.js';
export {
  resetStreamIdempotencyStore,
  setIdempotencyDependencyState,
  setIdempotencyStore,
  setStreamListingDependencyState,
} from './streams/state.js';

export const streamsRouter = Router();
registerReadRoutes(streamsRouter);
registerWriteRoutes(streamsRouter);
registerSseRoutes(streamsRouter);
registerLongPollRoutes(streamsRouter);

/** Legacy shim retained for existing test imports. */
export const streams: Stream[] = [];

/** Legacy no-op retained for existing test imports. */
export function _resetStreams(): void {}
