import Database from 'better-sqlite3';
import crypto from 'crypto';

import {
  isSupersededCrawlerType,
  keepActiveCrawlerTypes,
  SUPERSEDED_REASON,
} from '../../shared/supersededCrawlerTypes.js';

const db = new Database('./data/grantflow.db');

console.log('=== QUEUING CRAWLERS FOR ALL PROFILES ===\n');

// Get all profiles
const profiles = db.prepare('SELECT id, display_name, primary_type FROM profiles ORDER BY display_name').all();
console.log(`Found ${profiles.length} profiles\n`);

// Crawler types this script was written to queue. THREE OF THESE FOUR ARE DEAD.
//
// `local`, `scholarship` and `comprehensive` are all in
// `shared/supersededCrawlerTypes.js`: grant discovery moved to the Crawler OS,
// `createCrawlerJob` refuses to persist a row for a retired type, and
// `crawlerDispatcher` short-circuits any that reach it to
// `status='completed', error=SUPERSEDED_REASON` WITHOUT RUNNING ANYTHING.
//
// This script does a RAW INSERT, so it bypassed that choke point entirely: on a
// 30-profile fleet it printed "Total jobs queued: 120" and "All crawler jobs
// queued!" while 90 of those 120 jobs could never discover a single funding
// source. An operator reading the summary had no way to tell.
//
// Filter to the types that still run, and REPORT the refusal rather than
// silently shrinking the list — a tool that quietly does less than it says is
// the defect being fixed here.
const requestedCrawlerTypes = ['local', 'scholarship', 'comprehensive', 'profile_enrichment'];
const crawlerTypes = keepActiveCrawlerTypes(requestedCrawlerTypes);
const refusedCrawlerTypes = requestedCrawlerTypes.filter((t) => isSupersededCrawlerType(t));

if (refusedCrawlerTypes.length > 0) {
  console.log(`⚠️  Skipping ${refusedCrawlerTypes.length} retired crawler type(s): ${refusedCrawlerTypes.join(', ')}`);
  console.log(`   Reason: ${SUPERSEDED_REASON}`);
  console.log('   Grant discovery now runs through the Crawler OS (Robert), not the job queue.');
  console.log('   Queuing these would create rows the dispatcher completes without running.\n');
}

if (crawlerTypes.length === 0) {
  console.log('Nothing to queue: every requested crawler type is retired. No jobs were created.');
  db.close();
  process.exit(0);
}

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
console.log(`Crawler types queued per profile: ${crawlerTypes.join(', ') || '(none)'}`);
if (refusedCrawlerTypes.length > 0) {
  console.log(`Crawler types REFUSED as retired: ${refusedCrawlerTypes.join(', ')}`);
}
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
