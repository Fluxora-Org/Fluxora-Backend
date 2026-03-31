/**
 * Tests for stream repository
 *
 * Tests idempotent event ingestion, filtering, and pagination
 */

import Database from "better-sqlite3";

// Mock the database module
jest.mock("../src/db/connection.js", () => ({
  getDatabase: jest.fn(),
}));

import { streamRepository } from "../src/db/repositories/streamRepository.js";
import { getDatabase } from "../src/db/connection.js";

const mockDb = {
  prepare: jest.fn(),
  exec: jest.fn(),
} as unknown as Database.Database;

beforeEach(() => {
  jest.clearAllMocks();
  (getDatabase as jest.Mock).mockReturnValue(mockDb);
});

describe("streamRepository", () => {
  describe("upsertStream", () => {
    const validInput = {
      id: "stream-abc123def456-0",
      sender_address:
        "GCSX2QMKB3C7MFD3C4J5ZM3PJG2LX4RHH4R4H2K7RXA4X7ZM5J5Z5Z5Z5Z5",
      recipient_address:
        "GDRXE2PFUD66M3H4R44BFM6F4Q4Z3X4Y5Z6M3H4R44BFM6F4Q4Z3X4Y5Z",
      amount: "1000.0000000",
      streamed_amount: "0",
      remaining_amount: "1000.0000000",
      rate_per_second: "0.0000116",
      start_time: 1709123456,
      end_time: 1711719456,
      contract_id: "C1234567890abcdef",
      transaction_hash:
        "abc123def456789012345678901234567890123456789012345678901234",
      event_index: 0,
    };

    it("should create a new stream when it does not exist", () => {
      // Mock: no existing stream
      mockDb.prepare
        .mockReturnValueOnce({ get: jest.fn().mockReturnValue(undefined) }) // Check for existing by tx+event
        .mockReturnValueOnce({ get: jest.fn().mockReturnValue(undefined) }) // Check for existing by ID
        .mockReturnValueOnce({ run: jest.fn() }) // Insert
        .mockReturnValueOnce({ get: jest.fn().mockReturnValue(validInput) }); // Get created

      const result = streamRepository.upsertStream(validInput);

      expect(result.created).toBe(true);
      expect(result.updated).toBe(false);
    });

    it("should return existing stream when idempotent (same tx+event)", () => {
      mockDb.prepare.mockReturnValueOnce({
        get: jest.fn().mockReturnValue(validInput),
      }); // Existing found

      const result = streamRepository.upsertStream(validInput);

      expect(result.created).toBe(false);
      expect(result.updated).toBe(false);
      expect(result.stream).toEqual(validInput);
    });

    it("should validate input - reject invalid ID format", () => {
      const invalidInput = {
        ...validInput,
        id: "invalid-id",
      };

      expect(() => streamRepository.upsertStream(invalidInput)).toThrow(
        "Invalid stream input",
      );
    });

    it("should validate input - reject invalid sender address", () => {
      const invalidInput = {
        ...validInput,
        sender_address: "INVALID",
      };

      expect(() => streamRepository.upsertStream(invalidInput)).toThrow(
        "Invalid stream input",
      );
    });

    it("should validate input - reject invalid amount format", () => {
      const invalidInput = {
        ...validInput,
        amount: "not-a-number",
      };

      expect(() => streamRepository.upsertStream(invalidInput)).toThrow(
        "Invalid stream input",
      );
    });
  });

  describe("find", () => {
    it("should return paginated results with filter", () => {
      const mockStreams = [
        { id: "stream-1", status: "active" },
        { id: "stream-2", status: "active" },
      ];

      // Mock count query
      mockDb.prepare
        .mockReturnValueOnce({ get: jest.fn().mockReturnValue({ total: 2 }) }) // Count
        .mockReturnValueOnce({ all: jest.fn().mockReturnValue(mockStreams) }); // Select

      const result = streamRepository.find(
        { status: "active" },
        { limit: 20, offset: 0 },
      );

      expect(result.streams).toEqual(mockStreams);
      expect(result.total).toBe(2);
      expect(result.hasMore).toBe(false);
    });

    it("should handle empty results", () => {
      mockDb.prepare
        .mockReturnValueOnce({ get: jest.fn().mockReturnValue({ total: 0 }) })
        .mockReturnValueOnce({ all: jest.fn().mockReturnValue([]) });

      const result = streamRepository.find({}, { limit: 20, offset: 0 });

      expect(result.streams).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("getById", () => {
    it("should return stream when found", () => {
      const mockStream = { id: "stream-1", status: "active" };
      mockDb.prepare.mockReturnValueOnce({
        get: jest.fn().mockReturnValue(mockStream),
      });

      const result = streamRepository.getById("stream-1");

      expect(result).toEqual(mockStream);
    });

    it("should return undefined when not found", () => {
      mockDb.prepare.mockReturnValueOnce({
        get: jest.fn().mockReturnValue(undefined),
      });

      const result = streamRepository.getById("nonexistent");

      expect(result).toBeUndefined();
    });
  });
});
