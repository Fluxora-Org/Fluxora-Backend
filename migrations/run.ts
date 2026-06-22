import { db } from '../src/db/client';
import * as migration000 from './000_initial_schema';
import * as migration001 from './001_add_contract_events_replay_indexes';
import * as migration002 from './002_create_replay_cursors';
import * as migration003 from './003_contract_events_partitioning_retention';

const migrations = [
  { name: '000_initial_schema', module: migration000 },
  { name: '001_add_contract_events_replay_indexes', module: migration001 },
  { name: '002_create_replay_cursors', module: migration002 },
  { name: '003_contract_events_partitioning_retention', module: migration003 },
];


async function runMigrations() {
  const client = await db.getClient();
  
  try {
    console.log('Starting migrations...');
    
    for (const migration of migrations) {
      console.log(`\nRunning migration: ${migration.name}`);
      await migration.module.up(client);
      console.log(`✓ Migration ${migration.name} completed`);
    }
    
    console.log('\n✓ All migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await db.close();
  }
}

runMigrations().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
