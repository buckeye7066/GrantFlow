import Database from 'better-sqlite3';
import path from 'path';
import OpenAI from 'openai';
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js';

const db = new Database('./data/grantflow.db');
const uploadDir = path.join(process.cwd(), 'uploads');

// Setup OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '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'
});

const getOpenAI = () => openai;

console.log('=== PROCESSING CRAWLER QUEUE ===\n');

// Get queued jobs (limit to avoid overwhelming)
const BATCH_SIZE = 5;
const queuedJobs = db.prepare(`
  SELECT cj.id, cj.type, cj.profile_id, p.display_name 
  FROM crawler_jobs cj
  LEFT JOIN profiles p ON cj.profile_id = p.id
  WHERE cj.status = 'queued' 
  ORDER BY cj.created_at 
  LIMIT ?
`).all(BATCH_SIZE);

console.log(`Processing ${queuedJobs.length} jobs (batch of ${BATCH_SIZE})\n`);

if (queuedJobs.length === 0) {
  console.log('No queued jobs to process.');
  db.close();
  process.exit(0);
}

// Dispatch each job
const promises = [];

for (const job of queuedJobs) {
  console.log(`🚀 Dispatching: ${job.type} for ${job.display_name || 'Unknown'}`);
  
  try {
    // dispatchCrawlerJob runs async in the background
    dispatchCrawlerJob({
      db,
      jobId: job.id,
      uploadDir,
      getOpenAI
    });
    promises.push(job.id);
  } catch (err) {
    console.log(`   ✗ Error: ${err.message}`);
  }
}

console.log(`\n✓ Dispatched ${promises.length} jobs`);
console.log('\nJobs are now running in background...');
console.log('Run this script again to process more jobs.');

// Wait a moment to let jobs start
await new Promise(r => setTimeout(r, 3000));

// Check current status
const status = {
  queued: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'queued'").get().c,
  running: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'running'").get().c,
  completed: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'completed'").get().c,
  failed: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'failed'").get().c
};

console.log('\n=== CURRENT STATUS ===');
console.log(`Queued: ${status.queued}`);
console.log(`Running: ${status.running}`);
console.log(`Completed: ${status.completed}`);
console.log(`Failed: ${status.failed}`);

// Keep process alive for a bit to let jobs complete
console.log('\nWaiting 30 seconds for jobs to progress...');
await new Promise(r => setTimeout(r, 30000));

// Final status
const finalStatus = {
  queued: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'queued'").get().c,
  running: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'running'").get().c,
  completed: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'completed'").get().c,
  failed: db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'failed'").get().c
};

console.log('\n=== FINAL STATUS ===');
console.log(`Queued: ${finalStatus.queued}`);
console.log(`Running: ${finalStatus.running}`);
console.log(`Completed: ${finalStatus.completed}`);
console.log(`Failed: ${finalStatus.failed}`);

// Show any errors
const errors = db.prepare("SELECT type, error FROM crawler_jobs WHERE status = 'failed' AND error IS NOT NULL LIMIT 5").all();
if (errors.length > 0) {
  console.log('\nRecent errors:');
  errors.forEach(e => console.log(`  ${e.type}: ${e.error?.substring(0, 100)}`));
}

db.close();
