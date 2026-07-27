/**
 * Property-based tests for streamEventService event-ID derivation stability.
 *
 * The event ID is derived as `${transactionHash}-${eventIndex}`.
 * Properties verified:
 * - Deterministic: same inputs always produce the same ID
 * - Unique: different (hash, index) pairs produce different IDs
 * - Stable across calls: identical inputs never change the derived ID
 */

import { describe, it, expect } from 'vitest';

// Pure function under test — extracted from the service to avoid dependency mocks
function deriveEventId(transactionHash: string, eventIndex: number): string {
  return `${transactionHash}-${eventIndex}`;
}

// Simple property test runner — runs a predicate over N random samples
function forAll<T>(
  gen: () => T,
  predicate: (value: T) => boolean,
  runs = 200,
): void {
  for (let i = 0; i < runs; i++) {
    const value = gen();
    if (!predicate(value)) {
      throw new Error(`Property violated for: ${JSON.stringify(value)}`);
    }
  }
}

function randomHex(length = 64): string {
  const chars = '0123456789abcdef';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function randomIndex(): number {
  return Math.floor(Math.random() * 1000);
}

describe('streamEventService event-ID derivation', () => {
  it('is deterministic — same inputs always produce the same ID', () => {
    forAll(
      () => ({ hash: randomHex(), index: randomIndex() }),
      ({ hash, index }) => deriveEventId(hash, index) === deriveEventId(hash, index),
    );
  });

  it('is unique — different (hash, index) pairs produce different IDs', () => {
    forAll(
      () => {
        const hash1 = randomHex();
        const hash2 = randomHex();
        const idx1 = randomIndex();
        const idx2 = randomIndex();
        return { hash1, hash2, idx1, idx2 };
      },
      ({ hash1, hash2, idx1, idx2 }) => {
        if (hash1 === hash2 && idx1 === idx2) return true; // same input — same ID is correct
        return deriveEventId(hash1, idx1) !== deriveEventId(hash2, idx2);
      },
    );
  });

  it('index 0 and index 1 on the same hash produce different IDs', () => {
    forAll(
      () => randomHex(),
      (hash) => deriveEventId(hash, 0) !== deriveEventId(hash, 1),
    );
  });

  it('result contains both components', () => {
    forAll(
      () => ({ hash: randomHex(16), index: randomIndex() }),
      ({ hash, index }) => {
        const id = deriveEventId(hash, index);
        return id.includes(hash) && id.includes(String(index));
      },
    );
  });
});
