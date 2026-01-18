import Database from 'better-sqlite3';
import path from 'path';
import OpenAI from 'openai';
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js';

const db = new Database('./data/grantflow.db');
const uploadDir = path.join(process.cwd(), 'uploads');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Missing OPENAI_API_KEY. Set it in your environment to run this script.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

const getOpenAI = () => openai;

console.log('=== PROCESSING ALL CRAWLER JOBS ===\n');

// Reset failed jobs
const resetResult = db.prepare("UPDATE crawler_jobs SET status = 'queued', error = NULL WHERE status = 'failed'").run();
if (resetResult.changes > 0) {
  console.log(`Reset ${resetResult.changes} failed jobs\n`);
}

const BATCH_SIZE = 10;
const MAX_BATCHES = 6; // Process up to 60 jobs

for (let batch = 0; batch < MAX_BATCHES; batch++) {
  const queuedJobs = db.prepare(`
    SELECT cj.id, cj.type, cj.profile_id, p.display_name 
    FROM crawler_jobs cj
    LEFT JOIN profiles p ON cj.profile_id = p.id
    WHERE cj.status = 'queued' 
    ORDER BY cj.created_at 
    LIMIT ?
  `).all(BATCH_SIZE);
  
  if (queuedJobs.length === 0) {
    console.log('No more queued jobs!');
    break;
  }
  
  console.log(`\n--- Batch ${batch + 1}: ${queuedJobs.length} jobs ---`);
  
  for (const job of queuedJobs) {
    console.log(`  🚀 ${job.type} for ${job.display_name?.substring(0, 20) || 'Unknown'}`);
    
    try {
      dispatchCrawlerJob({
        db,
        jobId: job.id,
        uploadDir,
        getOpenAI
      });
    } catch (err) {
      console.log(`     ✗ ${err.message}`);
    }
  }
  
  // Wait for batch to process
  console.log('  Waiting 20s for batch to complete...');
  await new Promise(r => setTimeout(r, 20000));
  
  // Status check
  const status = {
    queued: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'queued'").get().c,
    running: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'running'").get().c,
    completed: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'completed'").get().c,
    failed: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'failed'").get().c
  };
  console.log(`  Status: Q:${status.queued} R:${status.running} C:${status.completed} F:${status.failed}`);
}

// Final summary
console.log('\n=== FINAL SUMMARY ===');
const finalStatus = db.prepare(`
  SELECT status, COUNT(*) as count 
  FROM crawler_jobs 
  GROUP BY status
`).all();

finalStatus.forEach(s => console.log(`${s.status}: ${s.count}`));

// Check opportunities found
const opportunities = db.prepare(`
  SELECT p.display_name, COUNT(DISTINCT pp.opportunity_id) as opps
  FROM profiles p
  LEFT JOIN profile_pipelines pp ON p.id = pp.profile_id
  GROUP BY p.id
  ORDER BY opps DESC
`).all();

console.log('\nOpportunities per profile:');
opportunities.forEach(o => {
  if (o.opps > 0) console.log(`  ✓ ${o.display_name}: ${o.opps} opportunities`);
  else console.log(`  - ${o.display_name}: 0`);
});

db.close();
console.log('\n✓ Done!');
