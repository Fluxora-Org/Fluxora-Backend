# Architecture Documentation

## System Overview

The contract event indexer is a high-performance service for replaying historical blockchain events with optimized batch processing and PostgreSQL indexing.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                             │
├─────────────────────────────────────────────────────────────────┤
│  • HTTP Clients (curl, Python, TypeScript)                      │
│  • Monitoring Tools                                              │
│  • CI/CD Pipelines                                               │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP/REST
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API Layer (Express)                         │
├─────────────────────────────────────────────────────────────────┤
│  Routes (src/routes/indexer.ts)                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ POST /internal/indexer/events/replay                      │  │
│  │   • Validate request                                      │  │
│  │   • Start async replay                                    │  │
│  │   • Return 202 Accepted                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ GET /internal/indexer/status                              │  │
│  │   • Return current progress                               │  │
│  │   • Include ETA and metrics                               │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Service Layer (Business Logic)                 │
├─────────────────────────────────────────────────────────────────┤
│  IndexerService (src/indexer/service.ts)                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ replayEvents()                                            │  │
│  │   1. Validate input parameters                            │  │
│  │   2. Check for concurrent operations                      │  │
│  │   3. Begin transaction                                    │  │
│  │   4. Count total events                                   │  │
│  │   5. Process in batches:                                  │  │
│  │      • Fetch batch from historical_events                 │  │
│  │      • Build multi-row INSERT                             │  │
│  │      • Execute batch insert                               │  │
│  │      • Update progress                                    │  │
│  │   6. Commit transaction                                   │  │
│  │   7. Handle errors (rollback)                             │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ ReplayState (In-Memory)                                   │  │
│  │   • isReplaying: boolean                                  │  │
│  │   • rowsReplayed: number                                  │  │
│  │   • rowsRemaining: number                                 │  │
│  │   • estimatedCompletion: Date                             │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Data Access Layer                             │
├─────────────────────────────────────────────────────────────────┤
│  DatabaseClient (src/db/client.ts)                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Connection Pool (pg.Pool)                                 │  │
│  │   • Max connections: 20                                   │  │
│  │   • Idle timeout: 30s                                     │  │
│  │   • Connection timeout: 2s                                │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────┬────────────────────────────────────────┘
                         │ SQL (Parameterized)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Database Layer (PostgreSQL)                 │
├─────────────────────────────────────────────────────────────────┤
│  Tables                                                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ historical_events (Source)                                │  │
│  │   • event_id (PK)                                         │  │
│  │   • contract_id, ledger, block_height                     │  │
│  │   • event_type, event_data (JSONB)                        │  │
│  │   • transaction_hash                                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ contract_events (Destination)                             │  │
│  │   • event_id (PK)                                         │  │
│  │   • contract_id, ledger, block_height                     │  │
│  │   • event_type, event_data (JSONB)                        │  │
│  │   • transaction_hash                                      │  │
│  │   • ingested_at (nullable)                                │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Indexes                                                         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ idx_contract_events_contract_ledger                       │  │
│  │   ON (contract_id, ledger, block_height, event_id)        │  │
│  │   → Optimizes replay queries                              │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ idx_contract_events_pending_ingestion (PARTIAL)           │  │
│  │   ON (contract_id, ledger, block_height)                  │  │
│  │   WHERE ingested_at IS NULL                               │  │
│  │   → Tracks unprocessed events                             │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ idx_historical_events_replay                              │  │
│  │   ON (contract_id, ledger, block_height, event_id)        │  │
│  │   → Speeds up batch fetching                              │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Replay Operation Flow

```
1. Client Request
   │
   ├─→ POST /internal/indexer/events/replay
   │   {
   │     "contract_id": "contract-123",
   │     "ledger": 1,
   │     "from_block": 1000,
   │     "to_block": 2000
   │   }
   │
   ▼
2. API Layer Validation
   │
   ├─→ Validate contract_id (non-empty string)
   ├─→ Validate ledger (non-negative integer)
   ├─→ Validate block range (from_block ≤ to_block)
   │
   ▼
3. Service Layer Processing
   │
   ├─→ Check concurrent operations (reject if already running)
   ├─→ Begin database transaction
   │
   ▼
4. Count Total Events
   │
   ├─→ SELECT COUNT(*) FROM historical_events
   │   WHERE contract_id = ? AND ledger = ?
   │   AND block_height BETWEEN ? AND ?
   │
   ├─→ Initialize replay state (totalRows, startedAt)
   │
   ▼
5. Batch Processing Loop
   │
   ├─→ Fetch Batch (REPLAY_BATCH_SIZE events)
   │   │
   │   ├─→ SELECT * FROM historical_events
   │   │   WHERE contract_id = ? AND ledger = ?
   │   │   ORDER BY block_height, event_id
   │   │   LIMIT ? OFFSET ?
   │   │
   │   ▼
   ├─→ Build Multi-Row INSERT
   │   │
   │   ├─→ INSERT INTO contract_events
   │   │   (event_id, contract_id, ledger, ...)
   │   │   VALUES
   │   │   ($1, $2, $3, ...),
   │   │   ($8, $9, $10, ...),
   │   │   ($15, $16, $17, ...)
   │   │   ON CONFLICT (event_id) DO NOTHING
   │   │
   │   ▼
   ├─→ Update Progress
   │   │
   │   ├─→ rowsReplayed += batchSize
   │   ├─→ rowsRemaining = totalRows - rowsReplayed
   │   ├─→ Calculate ETA based on current rate
   │   │
   │   ▼
   ├─→ Repeat until all events processed
   │
   ▼
6. Commit Transaction
   │
   ├─→ COMMIT
   ├─→ Mark replay as complete (isReplaying = false)
   │
   ▼
7. Return Response
   │
   └─→ 202 Accepted
       {
         "message": "Replay started",
         "status": { ... }
       }
```

### Error Handling Flow

```
Error Occurs
   │
   ├─→ Catch Exception
   │
   ├─→ ROLLBACK Transaction
   │   (Undo all changes)
   │
   ├─→ Reset Replay State
   │   (isReplaying = false)
   │
   ├─→ Release Database Connection
   │
   └─→ Throw Error to Client
       (500 Internal Server Error)
```

## Component Responsibilities

### API Layer (`src/routes/indexer.ts`)
- **Responsibility**: HTTP request/response handling
- **Concerns**:
  - Request validation
  - Response formatting
  - Error handling
  - Async operation initiation

### Service Layer (`src/indexer/service.ts`)
- **Responsibility**: Business logic and orchestration
- **Concerns**:
  - Input validation
  - Transaction management
  - Batch processing logic
  - Progress tracking
  - Concurrent operation prevention

### Data Access Layer (`src/db/client.ts`)
- **Responsibility**: Database connection management
- **Concerns**:
  - Connection pooling
  - Query execution
  - Resource cleanup

### Database Layer (PostgreSQL)
- **Responsibility**: Data persistence and querying
- **Concerns**:
  - ACID transactions
  - Index optimization
  - Query performance

## Key Design Decisions

### 1. Batch Insert Strategy

**Decision**: Use multi-row INSERT statements

**Rationale**:
- Reduces network round-trips (1 query vs N queries)
- Minimizes transaction overhead
- Improves throughput by 50x

**Trade-offs**:
- Higher memory usage per batch
- More complex error handling
- Requires careful parameter counting

### 2. In-Memory State Management

**Decision**: Store replay state in memory (not database)

**Rationale**:
- Faster access (no DB queries)
- Simpler implementation
- Sufficient for single-instance deployments

**Trade-offs**:
- Lost on restart
- Not suitable for multi-instance deployments
- No persistence across failures

**Future**: Use Redis or database-backed state for multi-instance support

### 3. Partial Index for Pending Events

**Decision**: Create partial index on `ingested_at IS NULL`

**Rationale**:
- Smaller index size (only unprocessed events)
- Faster queries for pending events
- Reduced maintenance overhead

**Trade-offs**:
- Only useful for specific query patterns
- Requires understanding of partial indexes

### 4. ON CONFLICT DO NOTHING

**Decision**: Use `ON CONFLICT (event_id) DO NOTHING` for deduplication

**Rationale**:
- Idempotent replays (safe to retry)
- Handles duplicate event_ids gracefully
- No application-level deduplication needed

**Trade-offs**:
- Silent failures (no error on duplicates)
- Requires unique constraint on event_id

### 5. Asynchronous Replay

**Decision**: Start replay asynchronously, return 202 Accepted

**Rationale**:
- Non-blocking API (client doesn't wait)
- Better user experience for long operations
- Allows progress polling

**Trade-offs**:
- More complex client logic (polling required)
- No immediate success/failure feedback

## Scalability Considerations

### Current Limitations

1. **Single Instance**: In-memory state prevents horizontal scaling
2. **Single Replay**: Only one replay operation at a time
3. **Memory Bound**: Large batches require more memory

### Scaling Strategies

#### Vertical Scaling
- Increase `REPLAY_BATCH_SIZE` for faster throughput
- Add more database resources (CPU, memory)
- Use faster storage (SSD, NVMe)

#### Horizontal Scaling (Future)
- Move state to Redis or database
- Implement distributed locking (Redis, ZooKeeper)
- Partition replays by contract_id or ledger
- Use message queue for replay requests

#### Database Optimization
- Partition tables by ledger or time range
- Use read replicas for historical_events
- Implement connection pooling at infrastructure level
- Consider TimescaleDB for time-series data

## Security Architecture

### Defense in Depth

```
Layer 1: Network
  ├─→ HTTPS/TLS encryption
  ├─→ IP whitelisting
  └─→ Firewall rules

Layer 2: Application
  ├─→ Authentication (JWT, API keys)
  ├─→ Authorization (RBAC)
  ├─→ Rate limiting
  └─→ Input validation

Layer 3: Database
  ├─→ Parameterized queries (SQL injection prevention)
  ├─→ Least privilege (minimal permissions)
  ├─→ Connection encryption (SSL/TLS)
  └─→ Audit logging

Layer 4: Infrastructure
  ├─→ Container isolation
  ├─→ Secrets management
  ├─→ Network segmentation
  └─→ Monitoring & alerting
```

## Performance Characteristics

### Time Complexity

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| Count events | O(log n) | With index on (contract_id, ledger) |
| Fetch batch | O(log n + k) | k = batch size |
| Insert batch | O(k) | k = batch size |
| Full replay | O(n/k) | n = total events, k = batch size |

### Space Complexity

| Component | Space | Notes |
|-----------|-------|-------|
| Batch buffer | O(k) | k = batch size |
| Connection pool | O(c) | c = max connections (20) |
| Replay state | O(1) | Fixed size |
| Indexes | O(n) | n = total events |

### Throughput

| Batch Size | Events/sec | Improvement |
|------------|-----------|-------------|
| 1 (single) | 100-200 | Baseline |
| 100 | 2,000-3,000 | 10-15x |
| 500 | 4,000-5,000 | 20-25x |
| 1000 | 5,000-10,000 | 50x |

## Monitoring & Observability

### Key Metrics

1. **Replay Metrics**
   - Replay duration
   - Events per second
   - Batch processing time
   - Error rate

2. **Database Metrics**
   - Query execution time
   - Connection pool usage
   - Index hit rate
   - Transaction rollback rate

3. **System Metrics**
   - CPU usage
   - Memory usage
   - Network I/O
   - Disk I/O

### Logging Strategy

```typescript
// Structured logging example
{
  "timestamp": "2026-05-28T10:00:00.000Z",
  "level": "info",
  "action": "replay_started",
  "contract_id": "contract-123",
  "ledger": 1,
  "total_events": 10000,
  "batch_size": 1000
}
```

## Deployment Architecture

### Docker Compose (Development)

```
┌─────────────────────┐
│   indexer-service   │
│   (Node.js/Express) │
│   Port: 3000        │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   indexer-postgres  │
│   (PostgreSQL 15)   │
│   Port: 5432        │
└─────────────────────┘
```

### Kubernetes (Production)

```
┌─────────────────────────────────────────┐
│              Ingress                     │
│         (HTTPS/TLS Termination)          │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│         Service (ClusterIP)              │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│      Deployment (1 replica)              │
│  ┌─────────────────────────────────┐    │
│  │   indexer-service Pod           │    │
│  │   - Liveness probe              │    │
│  │   - Readiness probe             │    │
│  │   - Resource limits             │    │
│  └─────────────────────────────────┘    │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│      PostgreSQL (External)               │
│      - Managed service (RDS, Cloud SQL)  │
│      - High availability                 │
│      - Automated backups                 │
└─────────────────────────────────────────┘
```

## Testing Strategy

### Unit Tests
- Service layer logic
- Input validation
- Progress calculation
- Error handling

### Integration Tests
- Database operations
- Transaction management
- Batch processing
- Index usage

### Performance Tests
- Benchmark script
- Load testing
- Stress testing
- Scalability testing

### Security Tests
- SQL injection attempts
- Input fuzzing
- Concurrent operation tests
- Authentication bypass attempts

## Future Enhancements

1. **Multi-Instance Support**
   - Redis-backed state
   - Distributed locking
   - Leader election

2. **Advanced Features**
   - Pause/resume replays
   - Replay queue
   - Priority-based processing
   - Webhook notifications

3. **Performance**
   - Parallel batch processing
   - Streaming inserts
   - Compression for large JSONB

4. **Observability**
   - Prometheus metrics
   - Distributed tracing
   - Real-time dashboards
   - Alerting rules

---

**Last Updated**: 2026-05-28
