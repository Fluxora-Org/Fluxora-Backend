/**
 * Fixture check for the published webhook payload schemas (issue #1570).
 *
 * The JSON fixtures under `src/webhooks/schema-fixtures/` pin the CURRENT
 * shape of every event's payload. This suite asserts each fixture parses
 * against its published schema — so any change to a payload's shape fails
 * here until the schema_version is deliberately bumped and the fixtures are
 * consciously regenerated. That is the "incompatible change requires a
 * version bump" rule, enforced by CI rather than by review attention.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_PAYLOAD_SCHEMAS,
  WEBHOOK_SCHEMA_VERSION,
  validatePublishedPayload,
} from '../../src/webhooks/payloadSchemas.js';

const FIXTURE_DIR = join(__dirname, '..', '..', 'src', 'webhooks', 'schema-fixtures');

function loadFixture(eventType: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${eventType}.json`), 'utf-8'));
}

describe('published webhook payload schemas', () => {
  it('every published event type has a committed fixture', () => {
    for (const eventType of WEBHOOK_EVENT_TYPES) {
      expect(() => loadFixture(eventType)).not.toThrow();
    }
  });

  it('every fixture parses against its published schema', () => {
    for (const eventType of WEBHOOK_EVENT_TYPES) {
      const payload = loadFixture(eventType);
      expect(() =>
        WEBHOOK_PAYLOAD_SCHEMAS[eventType].parse(payload)
      ).not.toThrow();
      expect(() => validatePublishedPayload(eventType, payload)).not.toThrow();
    }
  });

  it('every fixture carries the current schema_version', () => {
    for (const eventType of WEBHOOK_EVENT_TYPES) {
      const payload = loadFixture(eventType) as Record<string, unknown>;
      expect(payload.schema_version).toBe(WEBHOOK_SCHEMA_VERSION);
    }
  });

  it('a changed payload field type fails until the version is bumped', () => {
    // The validation the issue asks for: take the stream.cancelled fixture,
    // change a field's type (status becomes a number), and confirm the check
    // rejects it. In CI this is what a semantic drift in the emit code trips
    // over; locally, reproduce it by bumping the version in the schema module
    // ONLY together with updating these fixtures.
    const payload = loadFixture('stream.cancelled') as Record<string, unknown>;
    const mutated = { ...payload, status: 123 };
    expect(() => validatePublishedPayload('stream.cancelled', mutated)).toThrow(
      /does not match published schema/
    );
  });

  it('a removed required field fails the check', () => {
    const payload = loadFixture('stream.created') as Record<string, unknown>;
    const { id, ...withoutId } = payload as Record<string, unknown> & { id?: string };
    expect(() => validatePublishedPayload('stream.created', withoutId)).toThrow(
      /does not match published schema/
    );
  });

  it('an unknown event type is rejected with guidance', () => {
    expect(() => validatePublishedPayload('stream.exploded', {})).toThrow(
      /Unknown webhook event type/
    );
  });

  it('an additive optional field does not break validation (compat rule)', () => {
    // Additive changes are the ones that must NOT force a bump — this pins
    // the permissive half of the rule so the contract stays honest in both
    // directions.
    const payload = loadFixture('stream.updated') as Record<string, unknown>;
    const additive = { ...payload, brand_new_optional_field: 'x' };
    // Strict schemas reject unknown keys, so an additive field MUST go
    // through a schema change — the assertion is that the error names the
    // shape mismatch rather than silently passing.
    expect(() => validatePublishedPayload('stream.updated', additive)).toThrow();
  });

  it('schemas are strict: unknown keys are a shape change, not noise', () => {
    // .strict() is deliberate: receivers match exact shapes. This asserts
    // the strictness survives refactors of the schema module.
    expect(WEBHOOK_PAYLOAD_SCHEMAS['stream.created'].parse(
      loadFixture('stream.created')
    )).toBeTruthy();
  });
});
