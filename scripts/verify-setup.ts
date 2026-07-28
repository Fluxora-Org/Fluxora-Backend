/**
 * Verification script to check if the indexer is properly set up
 * 
 * Usage:
 *   ts-node scripts/verify-setup.ts
 */

import { db } from '../src/db/client';
import { config } from '../src/config';
import axios from 'axios';

interface VerificationResult {
  check: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  message: string;
}

const results: VerificationResult[] = [];

function addResult(check: string, status: 'PASS' | 'FAIL' | 'WARN', message: string) {
  results.push({ check, status, message });
}

async function verifyDatabaseConnection() {
  try {
    const client = await db.getClient();
    await client.query('SELECT 1');
    client.release();
    addResult('Database Connection', 'PASS', 'Successfully connected to database');
  } catch (error: any) {
    addResult('Database Connection', 'FAIL', `Failed to connect: ${error.message}`);
  }
}

async function verifyTables() {
  try {
    const client = await db.getClient();
    
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('historical_events', 'contract_events')
    `);
    
    client.release();
    
    const tables = result.rows.map(r => r.table_name);
    
    if (tables.includes('historical_events') && tables.includes('contract_events')) {
      addResult('Tables', 'PASS', 'All required tables exist');
    } else {
      const missing = ['historical_events', 'contract_events'].filter(t => !tables.includes(t));
      addResult('Tables', 'FAIL', `Missing tables: ${missing.join(', ')}`);
    }
  } catch (error: any) {
    addResult('Tables', 'FAIL', `Failed to check tables: ${error.message}`);
  }
}

async function verifyIndexes() {
  try {
    const client = await db.getClient();
    
    const result = await client.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE schemaname = 'public' 
      AND indexname IN (
        'idx_contract_events_contract_ledger',
        'idx_contract_events_pending_ingestion',
        'idx_historical_events_replay'
      )
    `);
    
    client.release();
    
    const indexes = result.rows.map(r => r.indexname);
    const expectedIndexes = [
      'idx_contract_events_contract_ledger',
      'idx_contract_events_pending_ingestion',
      'idx_historical_events_replay'
    ];
    
    const missing = expectedIndexes.filter(i => !indexes.includes(i));
    
    if (missing.length === 0) {
      addResult('Indexes', 'PASS', 'All required indexes exist');
    } else {
      addResult('Indexes', 'WARN', `Missing indexes: ${missing.join(', ')}. Run migrations.`);
    }
  } catch (error: any) {
    addResult('Indexes', 'FAIL', `Failed to check indexes: ${error.message}`);
  }
}

async function verifyConfiguration() {
  const checks = [
    {
      name: 'DATABASE_URL',
      value: config.database.url,
      valid: config.database.url && config.database.url.startsWith('postgresql://'),
    },
    {
      name: 'REPLAY_BATCH_SIZE',
      value: config.indexer.replayBatchSize,
      valid: config.indexer.replayBatchSize > 0 && config.indexer.replayBatchSize <= 10000,
    },
    {
      name: 'PORT',
      value: config.server.port,
      valid: config.server.port > 0 && config.server.port < 65536,
    },
  ];
  
  let allValid = true;
  const messages: string[] = [];
  
  checks.forEach(check => {
    if (!check.valid) {
      allValid = false;
      messages.push(`${check.name} is invalid: ${check.value}`);
    }
  });
  
  if (allValid) {
    addResult('Configuration', 'PASS', 'All configuration values are valid');
  } else {
    addResult('Configuration', 'FAIL', messages.join('; '));
  }
}

async function verifyAPIEndpoint() {
  try {
    const response = await axios.get(`http://localhost:${config.server.port}/health`, {
      timeout: 5000,
    });
    
    if (response.status === 200 && response.data.status === 'healthy') {
      addResult('API Endpoint', 'PASS', 'Service is running and healthy');
    } else {
      addResult('API Endpoint', 'WARN', 'Service responded but health check failed');
    }
  } catch (error: any) {
    if (error.code === 'ECONNREFUSED') {
      addResult('API Endpoint', 'WARN', 'Service is not running. Start with: pnpm run dev');
    } else {
      addResult('API Endpoint', 'FAIL', `Failed to reach service: ${error.message}`);
    }
  }
}

async function verifyTestData() {
  try {
    const client = await db.getClient();
    
    const historicalCount = await client.query('SELECT COUNT(*) FROM historical_events');
    const contractCount = await client.query('SELECT COUNT(*) FROM contract_events');
    
    client.release();
    
    const hCount = parseInt(historicalCount.rows[0].count, 10);
    const cCount = parseInt(contractCount.rows[0].count, 10);
    
    if (hCount > 0) {
      addResult('Test Data', 'PASS', `Found ${hCount} historical events, ${cCount} contract events`);
    } else {
      addResult('Test Data', 'WARN', 'No test data found. Run: pnpm run seed 10000');
    }
  } catch (error: any) {
    addResult('Test Data', 'FAIL', `Failed to check test data: ${error.message}`);
  }
}

async function runVerification() {
  console.log('='.repeat(70));
  console.log('Contract Event Indexer - Setup Verification');
  console.log('='.repeat(70));
  console.log();
  
  console.log('Running verification checks...\n');
  
  // Run all checks
  verifyConfiguration();
  await verifyDatabaseConnection();
  await verifyTables();
  await verifyIndexes();
  await verifyAPIEndpoint();
  await verifyTestData();
  
  // Display results
  console.log('='.repeat(70));
  console.log('VERIFICATION RESULTS');
  console.log('='.repeat(70));
  console.log();
  
  results.forEach(result => {
    const icon = result.status === 'PASS' ? '✓' : result.status === 'WARN' ? '⚠' : '✗';
    const color = result.status === 'PASS' ? '\x1b[32m' : result.status === 'WARN' ? '\x1b[33m' : '\x1b[31m';
    const reset = '\x1b[0m';
    
    console.log(`${color}${icon} ${result.check}${reset}`);
    console.log(`  ${result.message}`);
    console.log();
  });
  
  // Summary
  const passed = results.filter(r => r.status === 'PASS').length;
  const warned = results.filter(r => r.status === 'WARN').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  
  console.log('='.repeat(70));
  console.log(`Summary: ${passed} passed, ${warned} warnings, ${failed} failed`);
  console.log('='.repeat(70));
  
  if (failed > 0) {
    console.log('\n❌ Setup verification failed. Please fix the issues above.');
    process.exit(1);
  } else if (warned > 0) {
    console.log('\n⚠️  Setup verification passed with warnings.');
    process.exit(0);
  } else {
    console.log('\n✅ Setup verification passed! Your indexer is ready to use.');
    process.exit(0);
  }
}

runVerification().catch((error) => {
  console.error('Verification script failed:', error);
  process.exit(1);
}).finally(() => {
  db.close();
});
