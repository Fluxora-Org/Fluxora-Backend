/**
 * Minimal type declarations for the 'pg' Node.js PostgreSQL driver.
 *
 * Covers only the surface area used by Fluxora-Backend (Pool, Client,
 * QueryResult, the pool's `error` event).  When `@types/pg` is installed
 * these declarations are superseded by the upstream package.
 *
 * The module is shaped so that both `import pg from 'pg'` (default import
 * with esModuleInterop) and `import { Pool } from 'pg'` (named import) work,
 * and `pg.Pool` / `pg.QueryResultRow` resolve as types via the merged
 * namespace.
 */
declare module 'pg' {
  import type { EventEmitter } from 'events';

  export interface QueryResultRow {
    [column: string]: unknown;
  }

  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    rows: R[];
    rowCount: number | null;
    command: string;
    fields: Array<{ name: string; dataTypeID: number }>;
  }

  export interface PoolOptions {
    connectionString?: string | undefined;
    min?: number | undefined;
    max?: number | undefined;
    connectionTimeoutMillis?: number | undefined;
    idleTimeoutMillis?: number | undefined;
    host?: string | undefined;
    port?: number | undefined;
    user?: string | undefined;
    password?: string | undefined;
    database?: string | undefined;
    ssl?: boolean | object | undefined;
  }

  export interface ClientConfig {
    connectionString?: string | undefined;
    host?: string | undefined;
    port?: number | undefined;
    user?: string | undefined;
    password?: string | undefined;
    database?: string | undefined;
    ssl?: boolean | object | undefined;
  }

  export class Client {
    constructor(config?: ClientConfig);
    connect(): Promise<void>;
    query<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }

  export class Pool extends EventEmitter {
    constructor(config?: PoolOptions);
    readonly totalCount: number;
    readonly idleCount: number;
    readonly waitingCount: number;
    readonly options: PoolOptions;
    query<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'connect' | 'acquire' | 'remove', listener: () => void): this;
  }

  export interface PoolClient {
    query<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<R>>;
    release(err?: Error | boolean): void;
  }

  const pgDefault: {
    Pool: typeof Pool;
    Client: typeof Client;
  };

  export default pgDefault;
}

/**
 * Type-only alias namespace so call-sites can write `pg.Pool` /
 * `pg.QueryResultRow` after `import pg from 'pg'`.  The default-imported
 * value is also named `pg` at runtime, and this namespace merges with it
 * for type lookups.
 */
declare namespace pg {
  type QueryResultRow = import('pg').QueryResultRow;
  type QueryResult<R extends QueryResultRow = QueryResultRow> = import('pg').QueryResult<R>;
  type PoolOptions = import('pg').PoolOptions;
  type ClientConfig = import('pg').ClientConfig;
  type PoolClient = import('pg').PoolClient;
  type Pool = import('pg').Pool;
  type Client = import('pg').Client;
}
