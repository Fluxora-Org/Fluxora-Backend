# Usage Examples

This document provides practical examples for using the contract event indexer.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Basic Replay Operations](#basic-replay-operations)
3. [Advanced Scenarios](#advanced-scenarios)
4. [Monitoring & Troubleshooting](#monitoring--troubleshooting)
5. [Performance Testing](#performance-testing)

## Quick Start

### 1. Setup with Docker

```bash
# Start PostgreSQL and indexer service
docker-compose up -d

# Check service health
curl http://localhost:3000/health

# Run migrations
docker-compose exec indexer pnpm run migrate

# Seed test data (10,000 events)
docker-compose exec indexer pnpm run seed 10000
```

### 2. Setup without Docker

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env with your PostgreSQL credentials

# Run migrations
pnpm run migrate

# Seed test data
pnpm run seed 10000

# Start service
pnpm run dev
```

## Basic Replay Operations

### Example 1: Replay All Events for a Contract

```bash
curl -X POST http://localhost:3000/internal/indexer/events/replay \
  -H "Content-Type: application/json" \
  -d '{
    "contract_id": "contract-0",
    "ledger": 1
  }'
```

**Response**:
```json
{
  "message": "Replay started",
  "status": {
    "isReplaying": true,
    "rowsReplayed": 0,
    "rowsRemaining": 100,
    "totalRows": 100,
    "estimatedCompletion": null,
    "startedAt": "2026-05-28T10:00:00.000Z",
    "contractId": "contract-0",
    "ledger": 1
  }
}
```

### Example 2: Replay Events with Block Range

```bash
curl -X POST http://localhost:3000/internal/indexer/events/replay \
  -H "Content-Type: application/json" \
  -d '{
    "contract_id": "contract-0",
    "ledger": 1,
    "from_block": 1000,
    "to_block": 2000
  }'
```

This replays only events between blocks 1000 and 2000 (inclusive).

### Example 3: Check Replay Status

```bash
curl http://localhost:3000/internal/indexer/status
```

**Response**:
```json
{
  "isReplaying": true,
  "rowsReplayed": 50,
  "rowsRemaining": 50,
  "totalRows": 100,
  "estimatedCompletion": "2026-05-28T10:05:00.000Z",
  "startedAt": "2026-05-28T10:00:00.000Z",
  "contractId": "contract-0",
  "ledger": 1
}
```

### Example 4: Wait for Replay Completion

```bash
#!/bin/bash

# Start replay
curl -X POST http://localhost:3000/internal/indexer/events/replay \
  -H "Content-Type: application/json" \
  -d '{
    "contract_id": "contract-0",
    "ledger": 1
  }'

# Poll status until complete
while true; do
  STATUS=$(curl -s http://localhost:3000/internal/indexer/status | jq -r '.isReplaying')
  
  if [ "$STATUS" = "false" ]; then
    echo "Replay completed!"
    break
  fi
  
  PROGRESS=$(curl -s http://localhost:3000/internal/indexer/status | jq -r '.rowsReplayed')
  TOTAL=$(curl -s http://localhost:3000/internal/indexer/status | jq -r '.totalRows')
  echo "Progress: $PROGRESS / $TOTAL"
  
  sleep 2
done
```

## Advanced Scenarios

### Scenario 1: Batch Replay Multiple Contracts

```bash
#!/bin/bash

CONTRACTS=("contract-0" "contract-1" "contract-2")
LEDGER=1

for CONTRACT in "${CONTRACTS[@]}"; do
  echo "Starting replay for $CONTRACT..."
  
  curl -X POST http://localhost:3000/internal/indexer/events/replay \
    -H "Content-Type: application/json" \
    -d "{
      \"contract_id\": \"$CONTRACT\",
      \"ledger\": $LEDGER
    }"
  
  # Wait for completion
  while true; do
    IS_REPLAYING=$(curl -s http://localhost:3000/internal/indexer/status | jq -r '.isReplaying')
    if [ "$IS_REPLAYING" = "false" ]; then
      break
    fi
    sleep 1
  done
  
  echo "✓ Completed replay for $CONTRACT"
done

echo "All replays completed!"
```

### Scenario 2: Incremental Replay (New Blocks Only)

```bash
#!/bin/bash

CONTRACT_ID="contract-0"
LEDGER=1

# Get the highest block already replayed
LAST_BLOCK=$(psql $DATABASE_URL -t -c \
  "SELECT MAX(block_height) FROM contract_events 
   WHERE contract_id = '$CONTRACT_ID' AND ledger = $LEDGER")

# Replay only new blocks
curl -X POST http://localhost:3000/internal/indexer/events/replay \
  -H "Content-Type: application/json" \
  -d "{
    \"contract_id\": \"$CONTRACT_ID\",
    \"ledger\": $LEDGER,
    \"from_block\": $((LAST_BLOCK + 1))
  }"
```

### Scenario 3: Replay with Progress Notifications

```typescript
// Node.js script for replay with progress updates

import axios from 'axios';

async function replayWithProgress(contractId: string, ledger: number) {
  const baseUrl = 'http://localhost:3000';
  
  // Start replay
  const startResponse = await axios.post(`${baseUrl}/internal/indexer/events/replay`, {
    contract_id: contractId,
    ledger: ledger,
  });
  
  console.log('Replay started:', startResponse.data);
  
  // Poll for progress
  let lastProgress = 0;
  
  while (true) {
    const statusResponse = await axios.get(`${baseUrl}/internal/indexer/status`);
    const status = statusResponse.data;
    
    if (!status.isReplaying) {
      console.log('✓ Replay completed!');
      break;
    }
    
    const progress = (status.rowsReplayed / status.totalRows) * 100;
    
    if (progress > lastProgress + 10) {
      console.log(`Progress: ${progress.toFixed(1)}% (${status.rowsReplayed}/${status.totalRows})`);
      
      if (status.estimatedCompletion) {
        const eta = new Date(status.estimatedCompletion);
        console.log(`  ETA: ${eta.toLocaleTimeString()}`);
      }
      
      lastProgress = progress;
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

replayWithProgress('contract-0', 1);
```

## Monitoring & Troubleshooting

### Check Database Status

```sql
-- Count events by contract and ledger
SELECT 
  contract_id,
  ledger,
  COUNT(*) as total_events,
  COUNT(*) FILTER (WHERE ingested_at IS NOT NULL) as ingested,
  COUNT(*) FILTER (WHERE ingested_at IS NULL) as pending
FROM contract_events
GROUP BY contract_id, ledger
ORDER BY contract_id, ledger;

-- Find slow queries
SELECT 
  query,
  calls,
  total_time,
  mean_time,
  max_time
FROM pg_stat_statements
WHERE query LIKE '%contract_events%'
ORDER BY mean_time DESC
LIMIT 10;

-- Check index usage
SELECT 
  schemaname,
  tablename,
  indexname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE tablename = 'contract_events'
ORDER BY idx_scan DESC;
```

### Monitor Replay Performance

```bash
#!/bin/bash

# Monitor replay rate
PREV_COUNT=0
while true; do
  STATUS=$(curl -s http://localhost:3000/internal/indexer/status)
  CURRENT_COUNT=$(echo $STATUS | jq -r '.rowsReplayed')
  
  if [ "$PREV_COUNT" -ne 0 ]; then
    RATE=$((CURRENT_COUNT - PREV_COUNT))
    echo "$(date '+%H:%M:%S') - Replayed: $CURRENT_COUNT, Rate: $RATE events/sec"
  fi
  
  PREV_COUNT=$CURRENT_COUNT
  sleep 1
done
```

### Troubleshooting: Replay Stuck

```bash
# Check if replay is actually running
curl http://localhost:3000/internal/indexer/status

# Check database connections
psql $DATABASE_URL -c "SELECT * FROM pg_stat_activity WHERE datname = 'indexer_db';"

# Check for locks
psql $DATABASE_URL -c "SELECT * FROM pg_locks WHERE NOT granted;"

# If stuck, restart the service (replay state is in-memory)
docker-compose restart indexer
```

## Performance Testing

### Run Benchmark

```bash
# Run built-in benchmark
pnpm run benchmark

# Expected output:
# ============================================================
# BENCHMARK RESULTS
# ============================================================
# ┌─────────┬──────────────────────────┬────────┬──────────────┬────────────┐
# │ (index) │         Method           │ Events │ Duration (s) │ Events/sec │
# ├─────────┼──────────────────────────┼────────┼──────────────┼────────────┤
# │    0    │   'Single Inserts'       │  1000  │    '5.23'    │    191     │
# │    1    │ 'Batch Inserts (size 100)'│ 1000  │    '0.45'    │   2222     │
# │    2    │ 'Batch Inserts (size 500)'│ 1000  │    '0.21'    │   4762     │
# │    3    │'Batch Inserts (size 1000)'│ 1000  │    '0.15'    │   6667     │
# └─────────┴──────────────────────────┴────────┴──────────────┴────────────┘
```

### Load Testing with Apache Bench

```bash
# Test status endpoint
ab -n 1000 -c 10 http://localhost:3000/internal/indexer/status

# Test replay endpoint (requires JSON)
# Create test file
cat > replay-request.json << EOF
{
  "contract_id": "contract-0",
  "ledger": 1
}
EOF

# Note: Replay endpoint will reject concurrent requests
# This tests the concurrent prevention mechanism
for i in {1..5}; do
  curl -X POST http://localhost:3000/internal/indexer/events/replay \
    -H "Content-Type: application/json" \
    -d @replay-request.json &
done
wait

# Expected: 1 success (202), 4 failures (409 Conflict)
```

### Stress Test with Large Dataset

```bash
# Seed large dataset
pnpm run seed 100000

# Replay with monitoring
time curl -X POST http://localhost:3000/internal/indexer/events/replay \
  -H "Content-Type: application/json" \
  -d '{
    "contract_id": "contract-0",
    "ledger": 1
  }'

# Monitor system resources
docker stats indexer-service
```

## Integration Examples

### Python Client

```python
import requests
import time

class IndexerClient:
    def __init__(self, base_url='http://localhost:3000'):
        self.base_url = base_url
    
    def start_replay(self, contract_id, ledger, from_block=None, to_block=None):
        payload = {
            'contract_id': contract_id,
            'ledger': ledger,
        }
        if from_block:
            payload['from_block'] = from_block
        if to_block:
            payload['to_block'] = to_block
        
        response = requests.post(
            f'{self.base_url}/internal/indexer/events/replay',
            json=payload
        )
        response.raise_for_status()
        return response.json()
    
    def get_status(self):
        response = requests.get(f'{self.base_url}/internal/indexer/status')
        response.raise_for_status()
        return response.json()
    
    def wait_for_completion(self, poll_interval=1):
        while True:
            status = self.get_status()
            if not status['isReplaying']:
                return status
            
            print(f"Progress: {status['rowsReplayed']}/{status['totalRows']}")
            time.sleep(poll_interval)

# Usage
client = IndexerClient()
client.start_replay('contract-0', 1)
result = client.wait_for_completion()
print(f"Completed! Replayed {result['rowsReplayed']} events")
```

### JavaScript/TypeScript Client

```typescript
import axios, { AxiosInstance } from 'axios';

interface ReplayRequest {
  contract_id: string;
  ledger: number;
  from_block?: number;
  to_block?: number;
}

interface ReplayStatus {
  isReplaying: boolean;
  rowsReplayed: number;
  rowsRemaining: number;
  totalRows: number;
  estimatedCompletion: string | null;
  startedAt: string | null;
  contractId?: string;
  ledger?: number;
}

class IndexerClient {
  private client: AxiosInstance;

  constructor(baseURL: string = 'http://localhost:3000') {
    this.client = axios.create({ baseURL });
  }

  async startReplay(request: ReplayRequest): Promise<ReplayStatus> {
    const response = await this.client.post('/internal/indexer/events/replay', request);
    return response.data.status;
  }

  async getStatus(): Promise<ReplayStatus> {
    const response = await this.client.get('/internal/indexer/status');
    return response.data;
  }

  async waitForCompletion(pollInterval: number = 1000): Promise<ReplayStatus> {
    while (true) {
      const status = await this.getStatus();
      
      if (!status.isReplaying) {
        return status;
      }
      
      console.log(`Progress: ${status.rowsReplayed}/${status.totalRows}`);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }
}

// Usage
const client = new IndexerClient();
await client.startReplay({ contract_id: 'contract-0', ledger: 1 });
const result = await client.waitForCompletion();
console.log(`Completed! Replayed ${result.rowsReplayed} events`);
```

## Production Deployment Example

### Kubernetes Deployment

```yaml
# indexer-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: indexer-service
spec:
  replicas: 1  # Single instance due to in-memory state
  selector:
    matchLabels:
      app: indexer
  template:
    metadata:
      labels:
        app: indexer
    spec:
      containers:
      - name: indexer
        image: your-registry/indexer:latest
        ports:
        - containerPort: 3000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: indexer-secrets
              key: database-url
        - name: REPLAY_BATCH_SIZE
          value: "1000"
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: indexer-service
spec:
  selector:
    app: indexer
  ports:
  - port: 3000
    targetPort: 3000
  type: ClusterIP
```

---

For more examples and use cases, see the [documentation](docs/indexer.md).
