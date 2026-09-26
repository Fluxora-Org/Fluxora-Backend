import { describe, it, expect } from 'vitest';
import { buildOpenApiSpec } from '../../src/openapi/spec.js';
import {
  ContractEventSchema,
  ReplayProgressSchema,
  ReplayCursorSchema,
  ReplayRequestSchema,
} from '../../src/types/index.js';

describe('OpenAPI Spec & Shared Types Synchronization', () => {
  it('includes OpenAPI component schemas for all shared Zod types', () => {
    const spec = buildOpenApiSpec() as any;
    const schemas = spec?.components?.schemas;

    expect(schemas).toBeDefined();
    expect(schemas.ReplayProgress).toBeDefined();
    expect(schemas.ReplayCursor).toBeDefined();
    expect(schemas.ReplayRequest).toBeDefined();
    expect(schemas.ContractEvent).toBeDefined();
  });

  it('matches key response shape fields for ReplayProgressSchema', () => {
    const spec = buildOpenApiSpec() as any;
    const replayProgressComponent = spec.components.schemas.ReplayProgress;
    const zodShape = ReplayProgressSchema.shape;

    const expectedKeys = Object.keys(zodShape);
    const openApiProps = Object.keys(replayProgressComponent.properties || {});

    for (const key of expectedKeys) {
      expect(openApiProps).toContain(key);
    }
  });

  it('matches key response shape fields for ContractEventSchema', () => {
    const spec = buildOpenApiSpec() as any;
    const contractEventComponent = spec.components.schemas.ContractEvent;
    const zodShape = ContractEventSchema.shape;

    const expectedKeys = Object.keys(zodShape);
    const openApiProps = Object.keys(contractEventComponent.properties || {});

    for (const key of expectedKeys) {
      expect(openApiProps).toContain(key);
    }
  });

  it('matches key request shape fields for ReplayRequestSchema', () => {
    const spec = buildOpenApiSpec() as any;
    const replayRequestComponent = spec.components.schemas.ReplayRequest;
    const zodShape = ReplayRequestSchema.shape;

    const expectedKeys = Object.keys(zodShape);
    const openApiProps = Object.keys(replayRequestComponent.properties || {});

    for (const key of expectedKeys) {
      expect(openApiProps).toContain(key);
    }
  });

  it('wires ReplayProgress component into GET /internal/indexer/status response schema', () => {
    const spec = buildOpenApiSpec() as any;
    const statusPath = spec.paths['/internal/indexer/status'];
    expect(statusPath).toBeDefined();

    const getResponseSchema = statusPath.get.responses['200'].content['application/json'].schema;
    expect(getResponseSchema).toBeDefined();
    expect(getResponseSchema.properties.data.$ref).toContain('ReplayProgress');
  });
});
