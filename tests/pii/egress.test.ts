import { describe, it, expect, vi } from 'vitest';
import { redactableFields } from '../../src/pii/policy.js';
import { logger } from '../../src/lib/logger.js';
import { getTracer, Tracer } from '../../src/tracing/hooks.js';
import { registry } from '../../src/metrics.js';
import { privacyHeaders, requestLogger, safeErrorHandler, responseSanitizer } from '../../src/middleware/pii.js';

describe('PII Egress Validation', () => {
  it('no policy-named field escapes on any path', () => {
    // 1. Get all policy-named fields
    const fields = redactableFields();
    expect(fields.size).toBeGreaterThan(0);
    
    // Create a record containing every policy-named field
    const record: Record<string, any> = {};
    for (const field of fields) {
      record[field] = 'sensitive-data';
    }
    
    // Add a normal field to ensure it passes through
    record['normalField'] = 'normal-data';

    // Path 1: API responses (res.json)
    let jsonCalled = false;
    const res: any = {
      json: (data: any) => {
        jsonCalled = true;
        for (const field of fields) {
          expect(data[field]).not.toBe('sensitive-data');
        }
        expect(data['normalField']).toBe('normal-data');
      }
    };
    
    // apply interceptor if any
    if (responseSanitizer) {
       responseSanitizer({} as any, res, () => {});
    }
    res.json(record);
    expect(jsonCalled).toBe(true);
    
    // Path 2: Logs
    let logWritten = false;
    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = (buffer: any) => {
      const data = JSON.parse(buffer.toString());
      if (data.normalField === 'normal-data') {
        logWritten = true;
        for (const field of fields) {
          expect(data[field]).not.toBe('sensitive-data');
        }
      }
      return true;
    };
    logger.info('test message', 'corr-id', record);
    process.stdout.write = originalStdoutWrite;
    expect(logWritten).toBe(true);

    // Path 3: Traces
    const tracer = getTracer({ enabled: true });
    const span = tracer.startSpan({ traceId: '1', tags: record });
    tracer.recordEvent(span, 'test-event', record);
    
    // check span.events
    const event = span.events.find(e => e.name === 'test-event');
    expect(event).toBeDefined();
    for (const field of fields) {
      expect((event?.attributes as any)?.[field]).not.toBe('sensitive-data');
      expect((span.context.tags as any)?.[field]).not.toBe('sensitive-data');
    }
    expect((event?.attributes as any)?.['normalField']).toBe('normal-data');

    // Path 4: Metric labels
    // metric.ts patches prom-client
    let metricObserveCalled = false;
    const mockMetric = {
      labels: (l: any) => {
        metricObserveCalled = true;
        for (const field of fields) {
          expect(l[field]).not.toBe('sensitive-data');
        }
      }
    };
    
    import { Counter } from 'prom-client';
    const counter = new Counter({ name: 'test', help: 'test', labelNames: Array.from(fields) });
    counter.inc(record);
    // getting the internal hash map to check what labels got recorded
    const metrics = (counter as any).hashMap;
    if (metrics) {
      for (const key in metrics) {
        expect(key).not.toContain('sensitive-data');
      }
    }
  });
});
