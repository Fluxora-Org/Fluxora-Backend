# Quick Start Guide

Get the contract event indexer running in 5 minutes.

## Prerequisites

- Docker & Docker Compose (recommended)
- OR Node.js 18+ and PostgreSQL 12+

## Option 1: Docker (Recommended)

### 1. Start Services

```bash
# Start PostgreSQL and indexer service
docker-compose up -d

# Check services are running
docker-compose ps
```

### 2. Run Migrations

```bash
# Create tables and indexes
docker-compose exec indexer pnpm run migrate
```

Expected output:
```
Starting migrations...

Running migration: 000_initial_schema
Creating initial schema...
✓ Migration 000_initial_schema completed

Running migration: 001_add_contract_events_replay_indexes
Creating contract_events replay indexes...
✓ Migration 001_add_contract_events_replay_indexes completed

✓ All migrations completed successfully
```

### 3. Seed Test Data

```bash
# Generate 10,000 test events
docker-compose exec indexer pnpm run seed 10000
```

### 4. Start a Replay

```bash
curl -X POST http://localhost:3000/internal/indexer/events/replay \
  -H "Content-Type: application/json" \
  -d '{
    "contract_id": "contract-0",
    "ledger": 1
  }'
```

### 5. Check Progress

```bash
curl http://localhost:3000/internal/indexer/status
```

### 6. Run Tests

```bash
docker-compose exec indexer pnpm test
```

### 7. Run Benchmark

```bash
docker-compose exec indexer pnpm run benchmark
```

## Option 2: Local Development

### 1. Install Dependencies

```bash
# Install pnpm if not already installed
npm install -g pnpm

# Install project dependencies
pnpm install
```

### 2. Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your PostgreSQL credentials
# DATABASE_URL=postgresql://user:password@localhost:5432/indexer_db
```

### 3. Setup Database

```bash
# Create database (if needed)
createdb indexer_db

# Run migrations
pnpm run migrate
```

### 4. Seed Test Data

```bash
pnpm run seed 10000
```

### 5. Start Service

```bash
# Development mode with auto-reload
pnpm run dev

# Or build and run production
pnpm run build
pnpm start
```

### 6. Test the API

```bash
# Start replay
curl -X POST http://localhost:3000/internal/indexer/events/replay \
  -H "Content-Type: application/json" \
  -d '{
    "contract_id": "contract-0",
    "ledger": 1
  }'

# Check status
curl http://localhost:3000/internal/indexer/status
```

### 7. Run Tests

```bash
pnpm test:coverage
```

## Verify Installation

### Check Health

```bash
curl http://localhost:3000/health
```

Expected: `{"status":"healthy"}`

### Check Database Connection

```bash
# Docker
docker-compose exec postgres psql -U indexer_user -d indexer_db -c "\dt"

# Local
psql $DATABASE_URL -c "\dt"
```

Expected tables:
- `historical_events`
- `contract_events`

### Check Indexes

```bash
# Docker
docker-compose exec postgres psql -U indexer_user -d indexer_db -c "\di"

# Local
psql $DATABASE_URL -c "\di"
```

Expected indexes:
- `idx_contract_events_contract_ledger`
- `idx_contract_events_pending_ingestion`
- `idx_historical_events_replay`

## Common Commands

### Docker

```bash
# View logs
docker-compose logs -f indexer

# Stop services
docker-compose down

# Restart services
docker-compose restart

# Clean up (removes volumes)
docker-compose down -v
```

### Development

```bash
# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Run tests in watch mode
pnpm test:watch

# Build TypeScript
pnpm run build

# Run benchmark
pnpm run benchmark

# Seed more data
pnpm run seed 100000
```

## Troubleshooting

### Port Already in Use

```bash
# Check what's using port 3000
lsof -i :3000

# Or use a different port
PORT=3001 pnpm run dev
```

### Database Connection Error

```bash
# Check PostgreSQL is running
docker-compose ps postgres

# Check connection string
echo $DATABASE_URL

# Test connection
psql $DATABASE_URL -c "SELECT 1"
```

### Migration Fails

```bash
# Check database exists
psql -l | grep indexer

# Drop and recreate (WARNING: deletes all data)
docker-compose down -v
docker-compose up -d
docker-compose exec indexer pnpm run migrate
```

### Tests Fail

```bash
# Ensure test database is clean
docker-compose down -v
docker-compose up -d
docker-compose exec indexer pnpm test
```

## Next Steps

1. **Read the documentation**: [docs/indexer.md](docs/indexer.md)
2. **Try examples**: [EXAMPLES.md](EXAMPLES.md)
3. **Review security**: [SECURITY.md](SECURITY.md)
4. **Check implementation**: [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)

## API Quick Reference

### Start Replay

```bash
POST /internal/indexer/events/replay
Content-Type: application/json

{
  "contract_id": "string",
  "ledger": number,
  "from_block": number (optional),
  "to_block": number (optional)
}
```

### Get Status

```bash
GET /internal/indexer/status
```

### Health Check

```bash
GET /health
```

## Performance Tips

1. **Tune batch size**: Adjust `REPLAY_BATCH_SIZE` based on your hardware
   - Small (100-500): Lower memory, more round-trips
   - Medium (1000-2000): Balanced (recommended)
   - Large (5000+): Faster, higher memory

2. **Monitor resources**: Watch CPU, memory, and database connections
   ```bash
   docker stats indexer-service
   ```

3. **Run during off-peak**: Large replays can impact OLTP workload

4. **Use block ranges**: Replay incrementally for very large datasets
   ```bash
   # Replay in chunks
   curl -X POST http://localhost:3000/internal/indexer/events/replay \
     -d '{"contract_id": "contract-0", "ledger": 1, "from_block": 0, "to_block": 10000}'
   ```

## Getting Help

- **Documentation**: See [docs/indexer.md](docs/indexer.md)
- **Examples**: See [EXAMPLES.md](EXAMPLES.md)
- **Issues**: Check existing issues or create a new one
- **Security**: See [SECURITY.md](SECURITY.md)

---

**Ready to go!** 🚀

Your indexer is now running and ready to replay contract events with optimized batch processing.
