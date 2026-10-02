/**
 * HTTP-surface environment variables (request limits, GraphQL policy,
 * logging, CORS, tracing/OpenTelemetry).
 *
 * Every field is documented with its purpose and default; the composed schema
 * (`src/config/env.ts`) is unchanged in effect. The production LOG_LEVEL /
 * CORS invariants live in the composed schema's `superRefine`.
 */
import { z } from 'zod';
import { booleanEnv, byteSizeToNumber, integerEnv, optionalString, parseNumber } from './parsers.js';

/** Whole-byte positive integer parsed from sizes like '1mb'. */
function byteSizeEnv(name: string) {
  return z
    .preprocess(
      byteSizeToNumber,
      z
        .number()
        .int(`${name} must resolve to whole bytes`)
        .positive(`${name} must be positive`)
    )
    .default(1024 * 1024);
}

export const httpEnvSchema = {
  /** Maximum accepted request body size; parsed from byte sizes like '1mb'. @default 1048576 (1 MiB) */
  MAX_REQUEST_SIZE: byteSizeEnv('MAX_REQUEST_SIZE'),
  /** Maximum JSON nesting depth accepted by the body parser. @default 20 */
  MAX_JSON_DEPTH: integerEnv('MAX_JSON_DEPTH', 1, 1000).default(20),
  /** Per-request timeout in ms. @default 30000 */
  REQUEST_TIMEOUT_MS: integerEnv('REQUEST_TIMEOUT_MS', 1000, 300000).default(30000),
  /** Comma-separated SHA-256 allowlist for GraphQL persisted queries. */
  GRAPHQL_PERSISTED_QUERY_ALLOWLIST: optionalString('GRAPHQL_PERSISTED_QUERY_ALLOWLIST'),
  /** Require APQ hashes to match the allowlist. @default true */
  GRAPHQL_PERSISTED_QUERY_HASH_VERIFICATION: booleanEnv().default(true),
  /** Policy for non-persisted GraphQL queries: 'allow' or 'reject'. @default 'allow' */
  GRAPHQL_UNPERSISTED_QUERY_POLICY: z.enum(['allow', 'reject']).default('allow'),
  /** Allow the GraphQL introspection query. @default true */
  GRAPHQL_INTROSPECTION_ENABLED: booleanEnv().default(true),

  /** Application log verbosity. Must not be 'debug' in production. @default 'info' */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Expose Prometheus metrics at /metrics. @default true */
  METRICS_ENABLED: booleanEnv().default(true),
  /** Comma-separated CORS origins; '*' is rejected in production. */
  CORS_ALLOWED_ORIGINS: optionalString('CORS_ALLOWED_ORIGINS'),

  /**
   * Tracing / OpenTelemetry knobs.
   * Present in EnvSchema so `toConfig()` always receives validated defaults
   * rather than `undefined` (which previously made startup config non-deterministic
   * across deploys that omit these vars).
   */
  /** Master switch for distributed tracing. @default false */
  TRACING_ENABLED: booleanEnv().default(false),
  /** Head/tail sampling ratio between 0 and 1. @default 1 */
  TRACING_SAMPLE_RATE: z.preprocess(parseNumber, z.number().min(0).max(1)).default(1),
  /** Sampling strategy applied by the tracer. @default 'head' */
  TRACING_SAMPLING_STRATEGY: z
    .enum(['head', 'tail', 'always', 'never'])
    .default('head'),
  /** Overrides TRACING_SAMPLE_RATE when the head strategy is active. */
  TRACING_HEAD_SAMPLE_RATE: z
    .preprocess(parseNumber, z.number().min(0).max(1))
    .optional(),
  /** Keep spans carrying error status under tail sampling. @default true */
  TRACING_TAIL_KEEP_ERRORS: booleanEnv().default(true),
  /** JSON per-route sampling overrides, e.g. '{"/health":0}'. */
  TRACING_PER_ROUTE_OVERRIDES: optionalString('TRACING_PER_ROUTE_OVERRIDES'),
  /** Export traces to an OpenTelemetry collector. @default false */
  TRACING_OTEL_ENABLED: booleanEnv().default(false),
  /** Emit log records as OTel log events. @default false */
  TRACING_LOG_EVENTS: booleanEnv().default(false),
};
