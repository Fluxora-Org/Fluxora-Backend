import { describe, it, expect, vi, beforeEach } from "vitest";
import { streamEventService, _resetDedupCache, StreamCreatedEvent } from "../../src/services/streamEventService.js";
import { streamRepository } from "../../src/db/repositories/streamRepository.js";
import * as hub from "../../src/ws/hub.js";
import { CreateStreamInput } from "../../src/db/types.js";
import { deriveStreamId } from "../../src/streams/sseEmitter.js";

vi.mock("../../src/db/repositories/streamRepository.js", () => ({
  streamRepository: {
    upsertStream: vi.fn(),
    getById: vi.fn(),
    updateStream: vi.fn(),
  },
}));

vi.mock("../../src/ws/hub.js", () => ({
  getStreamHub: vi.fn(),
}));

vi.mock("../../src/tracing/hooks.js", () => ({
  enrichActiveSpanWithStream: vi.fn(),
  traceSpan: vi.fn((name, cid, tags, fn) => fn()),
}));

describe("streamEventService duplicate-event suppression", () => {
  const mockHub = {
    broadcast: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetDedupCache();
    vi.mocked(hub.getStreamHub).mockReturnValue(mockHub as any);
  });

  it("suppresses duplicate events and prevents fan-out", async () => {
    const event: StreamCreatedEvent = {
      type: "StreamCreated",
      contractId: "C123",
      transactionHash: "tx1",
      eventIndex: 0,
      sender: "G123",
      recipient: "G456",
      amount: "1000",
      ratePerSecond: "10",
      startTime: 1000,
      endTime: 2000,
    };

    const streamId = deriveStreamId(event.transactionHash, event.eventIndex);

    // Mock successful DB insertion for the first processing
    vi.mocked(streamRepository.upsertStream).mockResolvedValue({
      created: true,
      stream: {
        id: streamId,
        sender_address: event.sender,
        recipient_address: event.recipient,
      } as any,
    });

    // Feed the event the first time
    const result1 = await streamEventService.processEvent(event);

    expect(result1.success).toBe(true);
    expect(result1.action).toBe("created");
    expect(streamRepository.upsertStream).toHaveBeenCalledTimes(1);
    expect(mockHub.broadcast).toHaveBeenCalledTimes(1);

    // Reset mocks to cleanly verify the second call
    vi.mocked(streamRepository.upsertStream).mockClear();
    mockHub.broadcast.mockClear();

    // Feed the same event a second time
    const result2 = await streamEventService.processEvent(event);

    // It should be ignored and prevent DB upsert and fan-out
    expect(result2.success).toBe(true);
    expect(result2.action).toBe("ignored");
    expect(streamRepository.upsertStream).not.toHaveBeenCalled();
    expect(mockHub.broadcast).not.toHaveBeenCalled();
  });
});
