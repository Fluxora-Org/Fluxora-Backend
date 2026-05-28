import { PoolClient } from 'pg';
import { db } from '../db/client';
import { config } from '../config';
import { ContractEvent, ReplayProgress, ReplayRequest } from '../types';

/**
 * Replay state management (in-memory for single instance)
 * For multi-instance deployments, use Redis or database-backed state
 */
class ReplayState {
  private state: ReplayProgress = {
    isReplaying: false,
    rowsReplayed: 0,
    rowsRemaining: 0,
    totalRows: 0,
    estimatedCompletion: null,
    startedAt: null,
  };

  getState(): ReplayProgress {
    return { ...this.state };
  }

  startReplay(totalRows: number, contractId: string, ledger: number): void {
    this.state = {
      isReplaying: true,
      rowsReplayed: 0,
      rowsRemaining: totalRows,
      totalRows,
      estimatedCompletion: null,
      startedAt: new Date(),
      contractId,
      ledger,
    };
  }

  updateProgress(rowsProcessed: number): void {
    this.state.rowsReplayed += rowsProcessed;
    this.state.rowsRemaining = Math.max(0, this.state.totalRows - this.state.rowsReplayed);
    
    // Calculate estimated completion based on current rate
    if (this.state.startedAt && this.state.rowsReplayed > 0) {
      const elapsed = Date.now() - this.state.startedAt.getTime();
      const rate = this.state.rowsReplayed / elapsed; // rows per ms
      const remainingTime = this.state.rowsRemaining / rate;
      this.state.estimatedCompletion = new Date(Date.now() + remainingTime);
    }
  }

  endReplay(): void {
    this.state.isReplaying = false;
    this.state.estimatedCompletion = null;
  }

  isCurrentlyReplaying(): boolean {
    return this.state.isReplaying;
  }
}

export const replayState = new ReplayState();

/**
 * IndexerService handles contract event replay operations with batching
 */
export class IndexerService {
  private batchSize: number;

  constructor(batchSize?: number) {
    this.batchSize = batchSize || config.indexer.replayBatchSize;
  }

  /**
   * Replay historical contract events with batched inserts
   * 
   * Security considerations:
   * - Uses parameterized queries to prevent SQL injection
   * - Validates input parameters
   * - Prevents concurrent replay operations
   * - Uses transactions for atomicity
   * 
   * @param request Replay request parameters
   * @throws Error if replay is already in progress or parameters are invalid
   */
  async replayEvents(request: ReplayRequest): Promise<void> {
    // Validate input
    this.validateReplayRequest(request);

    // Prevent concurrent replays
    if (replayState.isCurrentlyReplaying()) {
      throw new Error('Replay operation already in progress');
    }

    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // Count total events to replay
      const totalRows = await this.countEventsToReplay(client, request);
      
      if (totalRows === 0) {
        replayState.endReplay();
        await client.query('COMMIT');
        return;
      }

      // Initialize replay state
      replayState.startReplay(totalRows, request.contract_id, request.ledger);

      // Process events in batches
      let offset = 0;
      while (offset < totalRows) {
        const events = await this.fetchEventBatch(client, request, offset, this.batchSize);
        
        if (events.length === 0) {
          break;
        }

        await this.batchInsertEvents(client, events);
        replayState.updateProgress(events.length);
        
        offset += events.length;
      }

      await client.query('COMMIT');
      replayState.endReplay();
    } catch (error) {
      await client.query('ROLLBACK');
      replayState.endReplay();
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Validate replay request parameters
   */
  private validateReplayRequest(request: ReplayRequest): void {
    if (!request.contract_id || typeof request.contract_id !== 'string') {
      throw new Error('Invalid contract_id');
    }
    if (typeof request.ledger !== 'number' || request.ledger < 0) {
      throw new Error('Invalid ledger');
    }
    if (request.from_block !== undefined && (typeof request.from_block !== 'number' || request.from_block < 0)) {
      throw new Error('Invalid from_block');
    }
    if (request.to_block !== undefined && (typeof request.to_block !== 'number' || request.to_block < 0)) {
      throw new Error('Invalid to_block');
    }
    if (request.from_block !== undefined && request.to_block !== undefined && request.from_block > request.to_block) {
      throw new Error('from_block must be less than or equal to to_block');
    }
  }

  /**
   * Count total events to replay
   */
  private async countEventsToReplay(client: PoolClient, request: ReplayRequest): Promise<number> {
    let query = `
      SELECT COUNT(*) as count
      FROM historical_events
      WHERE contract_id = $1 AND ledger = $2
    `;
    const params: any[] = [request.contract_id, request.ledger];

    if (request.from_block !== undefined) {
      query += ` AND block_height >= $${params.length + 1}`;
      params.push(request.from_block);
    }
    if (request.to_block !== undefined) {
      query += ` AND block_height <= $${params.length + 1}`;
      params.push(request.to_block);
    }

    const result = await client.query(query, params);
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Fetch a batch of events to replay
   */
  private async fetchEventBatch(
    client: PoolClient,
    request: ReplayRequest,
    offset: number,
    limit: number
  ): Promise<ContractEvent[]> {
    let query = `
      SELECT 
        event_id,
        contract_id,
        ledger,
        event_type,
        event_data,
        block_height,
        transaction_hash
      FROM historical_events
      WHERE contract_id = $1 AND ledger = $2
    `;
    const params: any[] = [request.contract_id, request.ledger];

    if (request.from_block !== undefined) {
      query += ` AND block_height >= $${params.length + 1}`;
      params.push(request.from_block);
    }
    if (request.to_block !== undefined) {
      query += ` AND block_height <= $${params.length + 1}`;
      params.push(request.to_block);
    }

    query += ` ORDER BY block_height ASC, event_id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await client.query(query, params);
    return result.rows;
  }

  /**
   * Batch insert events into contract_events table
   * Uses multi-row INSERT with ON CONFLICT to handle duplicate event_ids
   */
  private async batchInsertEvents(client: PoolClient, events: ContractEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    // Build multi-row INSERT statement
    const values: any[] = [];
    const valuePlaceholders: string[] = [];
    
    events.forEach((event, index) => {
      const baseIndex = index * 7;
      valuePlaceholders.push(
        `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7})`
      );
      values.push(
        event.event_id,
        event.contract_id,
        event.ledger,
        event.event_type,
        JSON.stringify(event.event_data),
        event.block_height,
        event.transaction_hash
      );
    });

    const query = `
      INSERT INTO contract_events (
        event_id,
        contract_id,
        ledger,
        event_type,
        event_data,
        block_height,
        transaction_hash
      ) VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (event_id) DO NOTHING
    `;

    await client.query(query, values);
  }

  /**
   * Get current replay progress
   */
  getReplayProgress(): ReplayProgress {
    return replayState.getState();
  }
}

export const indexerService = new IndexerService();
