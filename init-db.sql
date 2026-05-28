-- Initial database setup for Docker
-- This file is automatically executed when the PostgreSQL container starts

-- Ensure the database exists (already created by POSTGRES_DB env var)
\c indexer_db;

-- Create extensions if needed
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Grant necessary permissions
GRANT ALL PRIVILEGES ON DATABASE indexer_db TO indexer_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO indexer_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO indexer_user;

-- Log successful initialization
SELECT 'Database initialized successfully' AS status;
