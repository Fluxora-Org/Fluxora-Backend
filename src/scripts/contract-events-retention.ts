import pg from 'pg';
import type { DbOperationResult } from './db-ops.js';

export type ContractEventsRetentionMode = 'detach' | 'drop';

export interface ContractEventsRetentionOptions {
  databaseUrl: string;
  retainLedgers: number;
  currentLedger?: number;
  dryRun?: boolean;
  confirm?: boolean;
  backupConfirmed?: boolean;
  mode?: ContractEventsRetentionMode;
  parentTable?: 'contract_events' | 'contract_events_partitioned';
}

export interface ContractEventsRetentionPartition {
  name: string;
  startLedger: number;
  endLedger: number;
  rowEstimate: number;
}

export interface ContractEventsRetentionResult extends DbOperationResult {
  dryRun: boolean;
  mode: ContractEventsRetentionMode;
  currentLedger: number;
  cutoffLedger: number;
  partitions: ContractEventsRetentionPartition[];
  executedPartitions: string[];
}

function validateDatabaseUrl(url: string): { valid: boolean; reason?: string } {
  if (!url || url.trim() === '') {
    return { valid: false, reason: 'DATABASE_URL is required but was not provided.' };
  }
  if (!/^postgre(?:s|sql):\/\//i.test(url)) {
    return { valid: false, reason: 'DATABASE_URL must be a valid PostgreSQL connection string.' };
  }
  return { valid: true };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function redactDatabaseUrl(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgres://***@');
}

function failureResult(
  message: string,
  options: {
    dryRun: boolean;
    mode: ContractEventsRetentionMode;
    error?: string;
  },
): ContractEventsRetentionResult {
  return {
    success: false,
    message,
    ...(options.error ? { error: options.error } : {}),
    dryRun: options.dryRun,
    mode: options.mode,
    currentLedger: 0,
    cutoffLedger: 0,
    partitions: [],
    executedPartitions: [],
  };
}

async function queryCurrentLedger(client: pg.Client, parentTable: string): Promise<number> {
  const result = await client.query<{ current_ledger: string | number | null }>(
    `SELECT COALESCE(MAX(ledger), 0) AS current_ledger FROM ${quoteIdentifier(parentTable)}`,
  );
  return Number(result.rows[0]?.current_ledger ?? 0);
}

async function queryPartitions(
  client: pg.Client,
  parentTable: string,
): Promise<ContractEventsRetentionPartition[]> {
  const result = await client.query<{
    partition_name: string;
    start_ledger: string | number;
    end_ledger: string | number;
    row_estimate: string | number;
  }>(
    `
      SELECT
        child.relname AS partition_name,
        ((regexp_match(pg_get_expr(child.relpartbound, child.oid), 'FROM \\(([0-9]+)\\) TO \\(([0-9]+)\\)'))[1])::integer AS start_ledger,
        ((regexp_match(pg_get_expr(child.relpartbound, child.oid), 'FROM \\(([0-9]+)\\) TO \\(([0-9]+)\\)'))[2])::integer AS end_ledger,
        GREATEST(child.reltuples, 0)::bigint AS row_estimate
      FROM pg_inherits
      JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
      JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
      JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      WHERE namespace.nspname = 'public'
        AND parent.relname = $1
        AND pg_get_expr(child.relpartbound, child.oid) <> 'DEFAULT'
      ORDER BY start_ledger ASC
    `,
    [parentTable],
  );

  return result.rows.map((row) => ({
    name: row.partition_name,
    startLedger: Number(row.start_ledger),
    endLedger: Number(row.end_ledger),
    rowEstimate: Number(row.row_estimate),
  }));
}

async function auditRetentionAction(
  client: pg.Client,
  partition: ContractEventsRetentionPartition,
  parentTable: string,
  mode: ContractEventsRetentionMode,
  currentLedger: number,
  cutoffLedger: number,
): Promise<void> {
  const tableCheck = await client.query<{ audit_table: string | null }>(
    "SELECT to_regclass('public.audit_logs')::text AS audit_table",
  );
  if (!tableCheck.rows[0]?.audit_table) {
    return;
  }

  await client.query(
    `
      INSERT INTO audit_logs
        (seq, timestamp, action, resource_type, resource_id, correlation_id, meta)
      SELECT
        COALESCE(MAX(seq), 0) + 1,
        now()::text,
        $1,
        'contract_events_partition',
        $2,
        NULL,
        $3::jsonb
      FROM audit_logs
    `,
    [
      mode === 'drop'
        ? 'CONTRACT_EVENTS_PARTITION_DROP'
        : 'CONTRACT_EVENTS_PARTITION_DETACH',
      partition.name,
      JSON.stringify({
        parentTable,
        currentLedger,
        cutoffLedger,
        startLedger: partition.startLedger,
        endLedger: partition.endLedger,
        rowEstimate: partition.rowEstimate,
      }),
    ],
  );
}

/**
 * Enforce ledger-range retention for partitioned contract_events.
 *
 * The default is a dry run. Live runs require `confirm: true`, and permanent
 * drops additionally require `backupConfirmed: true`. Prefer `mode: "detach"`
 * for routine operations so the old partition remains available for backup or
 * manual re-attachment.
 */
export async function enforceContractEventsRetention(
  options: ContractEventsRetentionOptions,
): Promise<ContractEventsRetentionResult> {
  const dryRun = options.dryRun ?? true;
  const mode = options.mode ?? 'detach';
  const parentTable = options.parentTable ?? 'contract_events';
  const common = { dryRun, mode };

  const urlCheck = validateDatabaseUrl(options.databaseUrl);
  if (!urlCheck.valid) {
    return failureResult(urlCheck.reason!, common);
  }

  if (!Number.isInteger(options.retainLedgers) || options.retainLedgers <= 0) {
    return failureResult('retainLedgers must be a positive integer.', common);
  }

  if (!['contract_events', 'contract_events_partitioned'].includes(parentTable)) {
    return failureResult('parentTable must be contract_events or contract_events_partitioned.', common);
  }

  if (!dryRun && !options.confirm) {
    return failureResult('Live contract_events retention requires confirm: true.', common);
  }

  if (!dryRun && mode === 'drop' && !options.backupConfirmed) {
    return failureResult('Dropping contract_events partitions requires backupConfirmed: true.', common);
  }

  const client = new pg.Client({ connectionString: options.databaseUrl });

  try {
    await client.connect();

    const currentLedger = options.currentLedger ?? (await queryCurrentLedger(client, parentTable));
    const cutoffLedger = Math.max(0, currentLedger - options.retainLedgers + 1);
    const partitions = (await queryPartitions(client, parentTable))
      .filter((partition) => partition.endLedger <= cutoffLedger);

    if (dryRun || partitions.length === 0) {
      return {
        success: true,
        message: dryRun
          ? `Dry run: ${partitions.length} contract_events partition(s) eligible for ${mode}.`
          : 'No contract_events partitions are eligible for retention.',
        dryRun,
        mode,
        currentLedger,
        cutoffLedger,
        partitions,
        executedPartitions: [],
      };
    }

    const executedPartitions: string[] = [];
    await client.query('BEGIN');
    try {
      for (const partition of partitions) {
        const partitionName = quoteIdentifier(partition.name);
        const parentName = quoteIdentifier(parentTable);
        if (mode === 'drop') {
          await client.query(`DROP TABLE ${partitionName}`);
        } else {
          await client.query(`ALTER TABLE ${parentName} DETACH PARTITION ${partitionName}`);
        }
        await auditRetentionAction(client, partition, parentTable, mode, currentLedger, cutoffLedger);
        executedPartitions.push(partition.name);
      }
      await client.query('COMMIT');
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    }

    return {
      success: true,
      message: `${mode} completed for ${executedPartitions.length} contract_events partition(s).`,
      dryRun,
      mode,
      currentLedger,
      cutoffLedger,
      partitions,
      executedPartitions,
    };
  } catch (error: unknown) {
    const err = error as { message?: string };
    return failureResult('Contract events retention failed', {
      ...common,
      error: redactDatabaseUrl(err.message ?? 'Unknown database error'),
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
