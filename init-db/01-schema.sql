-- Initialize Fluxora database schema
-- This script runs automatically when PostgreSQL container starts for the first time

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Streams table for treasury streaming protocol
CREATE TABLE IF NOT EXISTS streams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stream_id VARCHAR(255) UNIQUE NOT NULL,
    sender VARCHAR(56) NOT NULL,
    recipient VARCHAR(56) NOT NULL,
    deposit_amount VARCHAR(64) NOT NULL,
    rate_per_second VARCHAR(64) NOT NULL,
    start_time BIGINT NOT NULL,
    end_time BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    contract_address VARCHAR(56),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Index for stream lookups
CREATE INDEX IF NOT EXISTS idx_streams_sender ON streams(sender);
CREATE INDEX IF NOT EXISTS idx_streams_recipient ON streams(recipient);
CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status);
CREATE INDEX IF NOT EXISTS idx_streams_created_at ON streams(created_at);

-- Indexer state tracking
CREATE TABLE IF NOT EXISTS indexer_state (
    id SERIAL PRIMARY KEY,
    cursor VARCHAR(255),
    last_ledger BIGINT,
    last_indexed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status VARCHAR(20) NOT NULL DEFAULT 'healthy',
    error_count INTEGER DEFAULT 0,
    last_error TEXT
);

-- Audit log for chain-derived state changes
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(50) NOT NULL,
    stream_id VARCHAR(255) REFERENCES streams(stream_id),
    transaction_hash VARCHAR(64),
    ledger_sequence BIGINT,
    old_values JSONB,
    new_values JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_stream_id ON audit_logs(stream_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- Webhook delivery tracking (for future implementation)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    delivery_id VARCHAR(255) UNIQUE NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    endpoint_url TEXT NOT NULL,
    status VARCHAR(20) NOT NULL,
    attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_delivery_id ON webhook_deliveries(delivery_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at ON webhook_deliveries(created_at);

-- API keys for authentication
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key_hash VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    permissions JSONB DEFAULT '[]',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE
);

-- Insert initial indexer state
INSERT INTO indexer_state (cursor, last_ledger, status)
VALUES (NULL, 0, 'not_configured')
ON CONFLICT DO NOTHING;
