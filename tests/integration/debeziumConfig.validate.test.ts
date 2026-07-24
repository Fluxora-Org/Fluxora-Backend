import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Debezium CDC Connector Config Validation', () => {
  const configPath = path.resolve(__dirname, '../../docs/integrations/debezium-connector.json');
  const schemaPath = path.resolve(__dirname, '../../init-db/01-schema.sql');

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

    // Parse streams table columns from init-db/01-schema.sql
    const streamsTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?streams\s*\(([\s\S]*?)\);/i;
    const match = schemaContent.match(streamsTableRegex);
    expect(match).not.toBeNull();

    const columnLines = match![1].split('\n');
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

    expect(columns.length).toBeGreaterThan(0);

    // Read connector configuration
    const configContent = fs.readFileSync(configPath, 'utf8');
    const json = JSON.parse(configContent);
    const config = json.config || {};

    // 1. Excluded columns validation
    const excludeList = config['column.exclude.list'] || '';
    if (excludeList) {
      const excludedCols = excludeList.split(',').map((c: string) => c.trim());
      for (const fullCol of excludedCols) {
        // Debezium format: schema.table.column (e.g. public.streams.sender_address)
        const parts = fullCol.split('.');
        expect(parts.length).toBe(3);
        expect(parts[0]).toBe('public');
        expect(parts[1]).toBe('streams');

        const colName = parts[2].toLowerCase();
        expect(columns, `Excluded column '${colName}' does not exist in streams table`).toContain(colName);
      }
    }

    // 2. Included columns validation (if present)
    const includeList = config['column.include.list'] || '';
    if (includeList) {
      const includedCols = includeList.split(',').map((c: string) => c.trim());
      for (const fullCol of includedCols) {
        const parts = fullCol.split('.');
        expect(parts.length).toBe(3);
        expect(parts[0]).toBe('public');
        expect(parts[1]).toBe('streams');

        const colName = parts[2].toLowerCase();
        expect(columns, `Included column '${colName}' does not exist in streams table`).toContain(colName);
      }
    }

    // 3. Masked columns validation (if present, e.g. column.mask.with.length.chars)
    for (const key of Object.keys(config)) {
      if (key.startsWith('column.mask.with.')) {
        const maskedList = config[key] || '';
        const maskedCols = maskedList.split(',').map((c: string) => c.trim());
        for (const fullCol of maskedCols) {
          const parts = fullCol.split('.');
          expect(parts.length).toBe(3);
          expect(parts[0]).toBe('public');
          expect(parts[1]).toBe('streams');

          const colName = parts[2].toLowerCase();
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
});
