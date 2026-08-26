import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Debezium CDC Connector Configuration Validation Tests
 * 
 * These tests validate that the Debezium connector configuration is:
 * 1. Syntactically valid JSON
 * 2. References only columns that exist in the schema
 * 3. Properly excludes PII-encrypted columns
 * 4. Follows security best practices
 * 
 * @security PII Protection: Ensures sender_address and recipient_address
 * columns are excluded from CDC topics by default to prevent data leakage
 */

describe('Debezium CDC Connector Config Validation', () => {
  const configPath = path.resolve(__dirname, '../../docs/integrations/debezium-connector.json');
  const schemaPath = path.resolve(__dirname, '../../init-db/01-schema.sql');

  /**
   * Parse streams table columns from init-db/01-schema.sql
   * Returns array of column names in lowercase
   */
  function parseStreamsTableColumns(schemaContent: string): string[] {
    const streamsTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?streams\s*\(([\s\S]*?)\);/i;
    const match = schemaContent.match(streamsTableRegex);
    
    if (!match) {
      throw new Error('Could not find streams table definition in schema file');
    }

    const columnLines = match[1].split('\n');
    const columns: string[] = [];

    for (const line of columnLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--')) {
        continue;
      }
      
      // Skip constraints/indexes/etc.
      if (
        trimmed.toUpperCase().startsWith('CONSTRAINT') ||
        trimmed.toUpperCase().startsWith('PRIMARY KEY') ||
        trimmed.toUpperCase().startsWith('FOREIGN KEY') ||
        trimmed.toUpperCase().startsWith('UNIQUE') ||
        trimmed.toUpperCase().startsWith('CHECK')
      ) {
        continue;
      }

      // The first word is the column name
      const parts = trimmed.split(/\s+/);
      const colName = parts[0].replace(/"/g, ''); // strip optional quotes
      if (colName) {
        columns.push(colName.toLowerCase());
      }
    }

    return columns;
  }

  /**
   * Parse Debezium column reference format (public.streams.column_name)
   * Returns array of column names
   */
  function parseDebeziumColumnRefs(columnList: string): string[] {
    if (!columnList) return [];
    
    return columnList.split(',').map((c: string) => {
      const trimmed = c.trim();
      const parts = trimmed.split('.');
      
      // Validate format: should be schema.table.column
      if (parts.length !== 3) {
        throw new Error(`Invalid Debezium column format: ${trimmed}. Expected format: schema.table.column`);
      }
      
      if (parts[0] !== 'public') {
        throw new Error(`Invalid schema in column reference: ${trimmed}. Expected 'public'`);
      }
      
      if (parts[1] !== 'streams') {
        throw new Error(`Invalid table in column reference: ${trimmed}. Expected 'streams'`);
      }
      
      return parts[2].toLowerCase();
    });
  }

  test('debezium-connector.json exists and is valid JSON', () => {
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, 'utf8');
    const json = JSON.parse(content);

    expect(json).toBeTypeOf('object');
    expect(json.name).toBe('fluxora-streams-cdc-connector');
    expect(json.config).toBeDefined();
    expect(json.config['connector.class']).toBe('io.debezium.connector.postgresql.PostgresConnector');
  });

  test('init-db/01-schema.sql exists and contains columns matching Debezium references', () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');
    const columns = parseStreamsTableColumns(schemaContent);

    expect(columns.length).toBeGreaterThan(0);

    // Read connector configuration
    const configContent = fs.readFileSync(configPath, 'utf8');
    const json = JSON.parse(configContent);
    const config = json.config || {};

    // 1. Excluded columns validation
    const excludeList = config['column.exclude.list'] || '';
    const excludedCols = parseDebeziumColumnRefs(excludeList);
    
    for (const colName of excludedCols) {
      expect(columns, `Excluded column '${colName}' does not exist in streams table`).toContain(colName);
    }

    // 2. Included columns validation (if present)
    const includeList = config['column.include.list'] || '';
    const includedCols = parseDebeziumColumnRefs(includeList);
    
    for (const colName of includedCols) {
      expect(columns, `Included column '${colName}' does not exist in streams table`).toContain(colName);
    }

    // 3. Masked columns validation (if present, e.g. column.mask.with.length.chars)
    for (const key of Object.keys(config)) {
      if (key.startsWith('column.mask.with.')) {
        const maskedList = config[key] || '';
        const maskedCols = parseDebeziumColumnRefs(maskedList);
        
        for (const colName of maskedCols) {
          expect(columns, `Masked column '${colName}' does not exist in streams table`).toContain(colName);
        }
      }
    }

    // 4. Validate table inclusion
    const tableIncludeList = config['table.include.list'] || '';
    if (tableIncludeList) {
      const includedTables = tableIncludeList.split(',').map((t: string) => t.trim());
      expect(includedTables).toContain('public.streams');
    }
  });

  test('PII columns are properly excluded from CDC topics', () => {
    expect(fs.existsSync(configPath)).toBe(true);
    const configContent = fs.readFileSync(configPath, 'utf8');
    const json = JSON.parse(configContent);
    const config = json.config || {};

    // Verify sender_address is excluded
    const excludeList = config['column.exclude.list'] || '';
    const excludedCols = parseDebeziumColumnRefs(excludeList);
    
    expect(excludedCols).toContain('sender_address');
    expect(excludedCols).toContain('recipient_address');
    
    // Verify these are the only excluded columns (defense-in-depth check)
    expect(excludedCols.length).toBe(2);
  });

  test('PII hash columns are NOT excluded (for correlation)', () => {
    expect(fs.existsSync(configPath)).toBe(true);
    const configContent = fs.readFileSync(configPath, 'utf8');
    const json = JSON.parse(configContent);
    const config = json.config || {};

    // Verify hash columns are NOT in exclude list
    const excludeList = config['column.exclude.list'] || '';
    const excludedCols = parseDebeziumColumnRefs(excludeList);
    
    expect(excludedCols).not.toContain('sender_address_hash');
    expect(excludedCols).not.toContain('recipient_address_hash');
  });

  test('connector configuration follows security best practices', () => {
    expect(fs.existsSync(configPath)).toBe(true);
    const configContent = fs.readFileSync(configPath, 'utf8');
    const json = JSON.parse(configContent);
    const config = json.config || {};

    // 1. Should not have hardcoded passwords in production configs
    // Note: This is a PoC config, so we allow placeholder values
    const password = config['database.password'] || '';
    expect(password).not.toBe('password');
    expect(password).not.toBe('postgres');
    expect(password).not.toBe('admin');

    // 2. Should use pgoutput plugin (logical decoding)
    expect(config['plugin.name']).toBe('pgoutput');

    // 3. Should have reasonable task count for PoC
    const tasksMax = parseInt(config['tasks.max'] || '1', 10);
    expect(tasksMax).toBeGreaterThanOrEqual(1);
    expect(tasksMax).toBeLessThanOrEqual(10);

    // 4. Should have decimal handling configured
    expect(config['decimal.handling.mode']).toBeDefined();
    expect(['double', 'precise', 'string']).toContain(config['decimal.handling.mode']);

    // 5. Should have time precision configured
    expect(config['time.precision.mode']).toBeDefined();
    expect(['connect', 'connectmilli', 'isostring']).toContain(config['time.precision.mode']);
  });

  test('connector has proper table inclusion configuration', () => {
    expect(fs.existsSync(configPath)).toBe(true);
    const configContent = fs.readFileSync(configPath, 'utf8');
    const json = JSON.parse(configContent);
    const config = json.config || {};

    const tableIncludeList = config['table.include.list'] || '';
    expect(tableIncludeList).toBe('public.streams');
    
    // Should not include other tables that might contain PII
    expect(tableIncludeList).not.toContain('audit_logs');
    expect(tableIncludeList).not.toContain('api_keys');
  });

  test('schema file contains all required security features', () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');

    // Verify pgcrypto extension is enabled
    expect(schemaContent).toContain('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    // Verify streams table has hash columns for PII correlation
    const columns = parseStreamsTableColumns(schemaContent);
    expect(columns).toContain('sender_address_hash');
    expect(columns).toContain('recipient_address_hash');

    // Verify streams table has encrypted address columns
    expect(columns).toContain('sender_address');
    expect(columns).toContain('recipient_address');
  });

  test('configuration is environment-configurable', () => {
    expect(fs.existsSync(configPath)).toBe(true);
    const configContent = fs.readFileSync(configPath, 'utf8');
    const json = JSON.parse(configContent);
    const config = json.config || {};

    // Verify database connection uses environment variables or placeholders
    const hostname = config['database.hostname'] || '';
    const port = config['database.port'] || '';
    const user = config['database.user'] || '';
    const dbname = config['database.dbname'] || '';

    // Should use environment variable syntax or be configurable
    // Check if values look like environment variable references
    const isEnvVar = (val: string) => val.startsWith('${') || val === 'localhost';
    
    expect(isEnvVar(hostname)).toBe(true);
    expect(isEnvVar(port)).toBe(true);
    expect(isEnvVar(user)).toBe(true);
    expect(isEnvVar(dbname)).toBe(true);
  });
});
