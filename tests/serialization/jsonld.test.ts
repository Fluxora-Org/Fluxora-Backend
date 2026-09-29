/**
 * JSON-LD context pinning — src/serialization/jsonld.ts
 *
 * The meaning of a JSON-LD document is defined by the context it references,
 * so every document published under `https://fluxora.dev/ns/v1` is only
 * interpretable as long as `v1` keeps meaning the same thing. These tests fail
 * if the emitted shape, the term definitions, or the context version drift
 * apart from the fixture that records the contract.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  toStreamJsonLd,
  FLUXORA_JSONLD_CONTEXT,
  FLUXORA_JSONLD_CONTEXT_DOCUMENT,
  FLUXORA_JSONLD_CONTEXT_PATH,
  FLUXORA_JSONLD_CONTEXT_VERSION,
  FLUXORA_STREAM_BASE_URI,
} from '../../src/serialization/jsonld.js';
import { docsRouter } from '../../src/routes/docs.js';
import type { StreamRecord } from '../../src/db/types.js';
import fixture from './fixtures/paymentStream.v1.json';

/** JSON-LD keywords are structural, not vocabulary terms. */
const STRUCTURAL_KEYS = ['@context', '@type', '@id'];

describe('JSON-LD context version', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(FLUXORA_JSONLD_CONTEXT_VERSION)).toBe(true);
    expect(FLUXORA_JSONLD_CONTEXT_VERSION).toBeGreaterThan(0);
  });

  it('carries the version in the context URI', () => {
    expect(FLUXORA_JSONLD_CONTEXT).toBe(
      `https://fluxora.dev/ns/v${FLUXORA_JSONLD_CONTEXT_VERSION}`,
    );
  });

  it('pins the served path to the version in the context URI', () => {
    expect(FLUXORA_JSONLD_CONTEXT_PATH).toBe(`/ns/v${FLUXORA_JSONLD_CONTEXT_VERSION}`);
    expect(new URL(FLUXORA_JSONLD_CONTEXT).pathname).toBe(FLUXORA_JSONLD_CONTEXT_PATH);
  });

  it('scopes the @vocab prefix to the version so terms cannot bleed across versions', () => {
    expect(FLUXORA_JSONLD_CONTEXT_DOCUMENT['@context']['@vocab']).toBe(
      `${FLUXORA_JSONLD_CONTEXT}#`,
    );
  });
});

describe('toStreamJsonLd() output is pinned by a fixture', () => {
  it('matches the recorded v1 document exactly', () => {
    expect(toStreamJsonLd(fixture.record as unknown as StreamRecord)).toEqual(
      fixture.document,
    );
  });

  it('emits the same keys, in the same order, as the fixture', () => {
    expect(Object.keys(toStreamJsonLd(fixture.record as unknown as StreamRecord))).toEqual(
      Object.keys(fixture.document),
    );
  });

  it('declares the same @context as the versioned constant', () => {
    const doc = toStreamJsonLd(fixture.record as unknown as StreamRecord);
    expect(doc['@context']).toBe(FLUXORA_JSONLD_CONTEXT);
  });
});

describe('Context document describes every emitted term', () => {
  const terms = Object.keys(FLUXORA_JSONLD_CONTEXT_DOCUMENT['@context']).filter(
    (key) => !key.startsWith('@') && key !== 'xsd',
  );

  // Read from the live serializer, not the fixture: a property added without a
  // matching context term would otherwise pass unnoticed.
  const emitted = Object.keys(toStreamJsonLd(fixture.record as unknown as StreamRecord)).filter(
    (key) => !STRUCTURAL_KEYS.includes(key),
  );

  it('defines a term for every emitted property', () => {
    expect(emitted.filter((key) => !terms.includes(key))).toEqual([]);
  });

  it('defines no term for a property the serializer no longer emits', () => {
    // A leftover term means a property was removed without a version bump.
    expect(terms.filter((term) => !emitted.includes(term))).toEqual([]);
  });

  it('types every amount as a decimal, never a float', () => {
    const ctx = FLUXORA_JSONLD_CONTEXT_DOCUMENT['@context'];
    for (const key of ['depositAmount', 'streamedAmount', 'remainingAmount', 'ratePerSecond']) {
      expect(ctx[key as keyof typeof ctx]).toBe('xsd:decimal');
    }
  });
});

describe('GET /ns/v1 — context document is served from a stable location', () => {
  const app = express().use(docsRouter);

  it('returns the context document as application/ld+json', async () => {
    const res = await request(app).get(FLUXORA_JSONLD_CONTEXT_PATH);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/ld+json');
    expect(res.body).toEqual(FLUXORA_JSONLD_CONTEXT_DOCUMENT);
  });

  it('is permanently cacheable and needs no authentication', async () => {
    const res = await request(app).get(FLUXORA_JSONLD_CONTEXT_PATH);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['www-authenticate']).toBeUndefined();
  });
});

describe('@id resolves to the stream resource', () => {
  it('uses the documented base URI and record id', () => {
    const doc = toStreamJsonLd(fixture.record as unknown as StreamRecord);
    expect(FLUXORA_STREAM_BASE_URI).toBe('https://fluxora.dev/streams');
    expect(doc['@id']).toBe(`${FLUXORA_STREAM_BASE_URI}/${fixture.record.id}`);
  });
});
