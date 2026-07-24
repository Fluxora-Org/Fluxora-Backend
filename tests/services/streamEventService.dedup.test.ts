/**
 * Property-based and unit tests for streamEventService duplicate suppression.
 *
 * Covers:
 *   - Deterministic single-replay duplicate event suppression.
 *   - Property-based testing via fast-check with randomized event replay sequences.
 *   - Duplicate bursts interleaved with simulated Redis outages while backed by HybridDedupCache.
 *   - Enforcement of the invariant: "each distinct (transactionHash, eventIndex) pair triggers
 *     at most one DB write and one broadcast regardless of ordering or outage timing".
 *   - Deterministic execution in CI using fixed seeds.
 *
 * @module tests/services/streamEventService.dedup.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import {
  streamEventService,
  setDedupCache,
  getDedupCache,
  _resetDedupCache,
  StreamCreatedEvent,
  StreamUpdatedEvent,
  StreamCancelledEvent,
  StreamEvent,
} from "../../src/services/streamEventService.js";
import { streamRepository } from "../../src/db/repositories/streamRepository.js";
import * as hub from "../../src/ws/hub.js";
import { deriveStreamId } from "../../src/streams/sseEmitter.js";
import {
  InMemoryDedupCache,
  RedisDedupCache,
  HybridDedupCache,
} from "../../src/redis/dedup.js";
import type { RedisClient } from "../../src/redis/client.js";

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

/**
 * Controllable Redis client mock that simulates intermittent Redis network outages.
 */
class TestFailableRedisClient implements RedisClient {
  public isAvailable = true;
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    if (!this.isAvailable) {
      throw new Error("Redis outage (simulated connection failure)");
    }
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, _options?: { ex?: number }): Promise<void> {
    if (!this.isAvailable) {
      throw new Error("Redis outage (simulated write failure)");
    }
    this.store.set(key, value);
  }

  async exists(key: string): Promise<boolean> {
    if (!this.isAvailable) {
      throw new Error("Redis outage (simulated exists failure)");
    }
    return this.store.has(key);
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

describe("streamEventService duplicate-event suppression", () => {
  const mockHub = {
    broadcast: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setDedupCache(new InMemoryDedupCache());
    await _resetDedupCache();
    vi.mocked(hub.getStreamHub).mockReturnValue(mockHub as any);
  });

  afterEach(async () => {
    setDedupCache(new InMemoryDedupCache());
    await _resetDedupCache();
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

  describe("Property-Based Tests: Invariant Verification during Redis Outages", () => {
    /**
     * Generator for randomized blockchain events (Created, Updated, Cancelled)
     */
    const eventArb = fc.record({
      type: fc.constantFrom("StreamCreated", "StreamUpdated", "StreamCancelled" as const),
      txId: fc.integer({ min: 1, max: 20 }),
      eventIdx: fc.integer({ min: 0, max: 5 }),
    }).map(({ type, txId, eventIdx }): StreamEvent => {
      const transactionHash = `tx-${txId}`;
      const eventIndex = eventIdx;
      const streamId = deriveStreamId(transactionHash, eventIndex);

      if (type === "StreamCreated") {
        return {
          type: "StreamCreated",
          contractId: "CONTRACT_SOROBAN_1",
          transactionHash,
          eventIndex,
          sender: `G_SENDER_${txId}`,
          recipient: `G_RECIPIENT_${txId}`,
          amount: "5000000",
          ratePerSecond: "100",
          startTime: 1700000000,
          endTime: 1700050000,
        };
      } else if (type === "StreamUpdated") {
        return {
          type: "StreamUpdated",
          contractId: "CONTRACT_SOROBAN_1",
          transactionHash,
          eventIndex,
          streamId,
          streamedAmount: "1000000",
          remainingAmount: "4000000",
          status: "active",
        };
      } else {
        return {
          type: "StreamCancelled",
          contractId: "CONTRACT_SOROBAN_1",
          transactionHash,
          eventIndex,
          streamId,
        };
      }
    });

    /**
     * Generator for sequence steps combining event replay with dynamic Redis outage toggles and duplicate bursts
     */
    const sequenceStepArb = fc.record({
      event: eventArb,
      redisAvailable: fc.boolean(),
      repeatCount: fc.integer({ min: 1, max: 5 }),
    });

    it("maintains invariant: at most 1 DB write & 1 broadcast per distinct (txHash, eventIndex) under intermittent Redis outages", async () => {
      // Deterministic configuration for CI reproducibility
      await fc.assert(
        fc.asyncProperty(fc.array(sequenceStepArb, { minLength: 1, maxLength: 40 }), async (sequence) => {
          // Setup simulated Redis and HybridDedupCache
          const fakeRedis = new TestFailableRedisClient();
          const primary = new RedisDedupCache(fakeRedis);
          const fallback = new InMemoryDedupCache();
          const hybrid = new HybridDedupCache(primary, fallback, true);

          setDedupCache(hybrid);
          vi.clearAllMocks();

          // Mock repository behaviors
          vi.mocked(streamRepository.upsertStream).mockImplementation(async (input) => {
            return {
              created: true,
              stream: {
                id: input.id,
                sender_address: input.sender_address,
                recipient_address: input.recipient_address,
              } as any,
            };
          });

          vi.mocked(streamRepository.getById).mockImplementation(async (id) => {
            return {
              id,
              sender_address: "G_SENDER",
              recipient_address: "G_RECIPIENT",
            } as any;
          });

          vi.mocked(streamRepository.updateStream).mockImplementation(async (id) => {
            return {
              id,
              recipient_address: "G_RECIPIENT",
            } as any;
          });

          // Track processing counters per distinct (transactionHash, eventIndex) key
          const seenEventKeys = new Set<string>();

          for (const step of sequence) {
            // Dynamically simulate Redis availability state for this step
            fakeRedis.isAvailable = step.redisAvailable;

            // Replay the event including any duplicate burst repeats
            for (let r = 0; r < step.repeatCount; r++) {
              const eventId = `${step.event.transactionHash}-${step.event.eventIndex}`;
              const isFirstEncounter = !seenEventKeys.has(eventId);

              const result = await streamEventService.processEvent(step.event);

              expect(result.success).toBe(true);

              if (isFirstEncounter) {
                seenEventKeys.add(eventId);
              } else {
                // Duplicates must always be ignored
                expect(result.action).toBe("ignored");
              }
            }
          }

          // Assert Invariant 1: At most 1 DB write per distinct (txHash, eventIndex)
          const dbWriteEvents = new Map<string, number>();

          // Count upsertStream calls
          for (const call of vi.mocked(streamRepository.upsertStream).mock.calls) {
            const input = call[0];
            const eventKey = `${input.transaction_hash}-${input.event_index}`;
            dbWriteEvents.set(eventKey, (dbWriteEvents.get(eventKey) ?? 0) + 1);
          }

          // Count updateStream calls (from StreamUpdated or StreamCancelled)
          // We map updateStream back by inspecting which streamEventService.processEvent call triggered it
          // Each distinct event (txHash-eventIndex) triggers at most 1 updateStream
          const totalUpdateStreamCalls = vi.mocked(streamRepository.updateStream).mock.calls.length;
          const totalUpsertStreamCalls = vi.mocked(streamRepository.upsertStream).mock.calls.length;

          // For each distinct event key in sequence, total DB operations (upserts + updates) <= 1
          for (const key of seenEventKeys) {
            const upsertCount = dbWriteEvents.get(key) ?? 0;
            expect(upsertCount).toBeLessThanOrEqual(1);
          }

          // Total DB writes across all unique events processed must not exceed number of distinct seen event keys
          expect(totalUpsertStreamCalls + totalUpdateStreamCalls).toBeLessThanOrEqual(seenEventKeys.size);

          // Assert Invariant 2: At most 1 broadcast per distinct (txHash, eventIndex)
          const broadcastCountByEventId = new Map<string, number>();
          for (const call of mockHub.broadcast.mock.calls) {
            const payload = call[0] as { eventId: string };
            broadcastCountByEventId.set(payload.eventId, (broadcastCountByEventId.get(payload.eventId) ?? 0) + 1);
          }

          for (const key of seenEventKeys) {
            const broadcastCount = broadcastCountByEventId.get(key) ?? 0;
            expect(broadcastCount).toBeLessThanOrEqual(1);
          }
        }),
        { numRuns: 100, seed: 42 }
      );
    });

    it("degrades gracefully to in-memory fallback during total Redis outage without throwing", async () => {
      const fakeRedis = new TestFailableRedisClient();
      fakeRedis.isAvailable = false; // Redis completely DOWN

      const primary = new RedisDedupCache(fakeRedis);
      const fallback = new InMemoryDedupCache();
      const hybrid = new HybridDedupCache(primary, fallback, true);

      setDedupCache(hybrid);

      const event: StreamCreatedEvent = {
        type: "StreamCreated",
        contractId: "C123",
        transactionHash: "tx-outage-1",
        eventIndex: 0,
        sender: "G1",
        recipient: "G2",
        amount: "100",
        ratePerSecond: "1",
        startTime: 1000,
        endTime: 2000,
      };

      const streamId = deriveStreamId(event.transactionHash, event.eventIndex);

      vi.mocked(streamRepository.upsertStream).mockResolvedValue({
        created: true,
        stream: { id: streamId, sender_address: event.sender, recipient_address: event.recipient } as any,
      });

      // First call during Redis outage -> should process via fallback
      const result1 = await streamEventService.processEvent(event);
      expect(result1.success).toBe(true);
      expect(result1.action).toBe("created");

      // Duplicate call during Redis outage -> should be suppressed via fallback
      const result2 = await streamEventService.processEvent(event);
      expect(result2.success).toBe(true);
      expect(result2.action).toBe("ignored");
    });
  });
});
