import Database from 'better-sqlite3';
import crypto from 'crypto';

const db = new Database('./data/grantflow.db');

console.log('=== QUEUING CRAWLERS FOR ALL PROFILES ===\n');

// Get all profiles
const profiles = db.prepare('SELECT id, display_name, primary_type FROM profiles ORDER BY display_name').all();
console.log(`Found ${profiles.length} profiles\n`);

// Crawler types to run
const crawlerTypes = ['local', 'scholarship', 'comprehensive', 'profile_enrichment'];

// Queue jobs for each profile
const insertJob = db.prepare(`
  INSERT INTO crawler_jobs (id, type, status, profile_id, parameters, requested_by, created_at)
  VALUES (?, ?, 'queued', ?, ?, 'admin-script', CURRENT_TIMESTAMP)
`);

let totalQueued = 0;

for (const profile of profiles) {
  console.log(`📋 ${profile.display_name}`);
  
  for (const crawlerType of crawlerTypes) {
    const jobId = crypto.randomUUID();
    
    // Set parameters based on crawler type
    let parameters = {};
    if (crawlerType === 'comprehensive') {
      parameters = { mode: 'geo' }; // Geo Crawl mode
    } else if (crawlerType === 'local') {
      parameters = { radius_miles: 50 };
    }
    
    try {
      insertJob.run(jobId, crawlerType, profile.id, JSON.stringify(parameters));
      console.log(`   ✓ ${crawlerType}`);
      totalQueued++;
    } catch (err) {
      console.log(`   ✗ ${crawlerType}: ${err.message}`);
    }
  }
  console.log('');
}

console.log(`\n=== SUMMARY ===`);
console.log(`Total jobs queued: ${totalQueued}`);

// Verify
const queued = db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'queued'").get().c;
console.log(`Jobs in queue: ${queued}`);

// Show breakdown
const byType = db.prepare("SELECT type, COUNT(*) as c FROM crawler_jobs WHERE status = 'queued' GROUP BY type").all();
console.log('\nBy type:');
byType.forEach(t => console.log(`  ${t.type}: ${t.c}`));

db.close();

console.log('\n✓ All crawler jobs queued!');
console.log('\n⚡ To process the queue, the crawler worker needs to be running.');
console.log('   The backend should automatically process queued jobs.');
