-- Initial database setup for Docker
-- This file is automatically executed when the PostgreSQL container starts

-- Ensure the database exists (already created by POSTGRES_DB env var)
\c indexer_db;

-- Create extensions if needed
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Grant permissions to the indexer user
GRANT ALL PRIVILEGES ON DATABASE indexer_db TO indexer_user;

-- Note: Tables and indexes will be created by running migrations
-- Run: docker-compose exec indexer pnpm run migrate
