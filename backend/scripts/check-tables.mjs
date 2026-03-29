import Database from 'better-sqlite3';

if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
  console.error('ERROR: This script only supports SQLite databases. DATABASE_URL points to PostgreSQL.')
  console.error('Use the application API or a Postgres client instead.')
  process.exit(1)
}

const db = new Database('./data/grantflow.db');

console.log('=== DATABASE TABLES ===\n');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(`Total tables: ${tables.length}\n`);

// Check for key tables
const keyTables = [
  'opportunities',
  'funding_opportunities', 
  'profile_pipelines',
  'grants',
  'profile_grants',
  'crawler_results',
  'discovered_opportunities'
];

console.log('Key tables:');
for (const name of keyTables) {
  const exists = tables.find(t => t.name === name);
  if (exists) {
    const count = db.prepare(`SELECT COUNT(*) as c FROM ${name}`).get().c;
    console.log(`  ✓ ${name}: ${count} rows`);
  } else {
    console.log(`  ❌ ${name}: NOT FOUND`);
  }
}

// List all tables containing pipeline or opportunity
console.log('\nAll matching tables:');
tables.filter(t => 
  t.name.includes('opp') || 
  t.name.includes('pipe') || 
  t.name.includes('fund') ||
  t.name.includes('grant') ||
  t.name.includes('discover')
).forEach(t => console.log(`  - ${t.name}`));

db.close();
