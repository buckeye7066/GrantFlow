import Database from 'better-sqlite3';

if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
  console.error('ERROR: This script only supports SQLite databases. DATABASE_URL points to PostgreSQL.')
  console.error('Use the application API or a Postgres client instead.')
  process.exit(1)
}

const db = new Database('./data/grantflow.db');

// Check funding_opportunities schema
console.log('=== FUNDING OPPORTUNITIES SCHEMA ===');
const info = db.prepare('PRAGMA table_info(funding_opportunities)').all();
console.log('Columns:', info.map(i => i.name).join(', '));

// Sample data
console.log('\n=== SAMPLE OPPORTUNITIES ===');
const opps = db.prepare('SELECT * FROM funding_opportunities LIMIT 3').all();
opps.forEach(o => {
  console.log(`\n- ${o.title || o.name || 'Untitled'}`);
  console.log(`  ID: ${o.id}`);
  Object.entries(o).slice(0, 8).forEach(([k, v]) => {
    if (v && k !== 'id') console.log(`  ${k}: ${String(v).substring(0, 50)}`);
  });
});

// Check grants schema
console.log('\n=== GRANTS SCHEMA ===');
const grantsInfo = db.prepare('PRAGMA table_info(grants)').all();
console.log('Columns:', grantsInfo.map(i => i.name).join(', '));

// Check how crawlers save results
console.log('\n=== CHECKING CRAWLER OUTPUT ===');
const recentJobs = db.prepare(`
  SELECT id, type, status, result_count, error 
  FROM crawler_jobs 
  WHERE status = 'completed' 
  ORDER BY completed_at DESC 
  LIMIT 5
`).all();

recentJobs.forEach(j => {
  console.log(`${j.type}: ${j.result_count || 0} results`);
});

db.close();
