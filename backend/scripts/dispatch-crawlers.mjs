import Database from 'better-sqlite3';
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js';
import path from 'path';

const db = new Database('./data/grantflow.db');
const uploadDir = path.join(process.cwd(), 'uploads');

// Mock getOpenAI function (never embed secrets)
const getOpenAI = async () => {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required to dispatch crawler jobs that use AI.')
  }
  const OpenAI = (await import('openai')).default
  return new OpenAI({ apiKey })
}

console.log('=== DISPATCHING QUEUED CRAWLER JOBS ===\n');

// Get queued jobs
const queuedJobs = db.prepare("SELECT id, type, profile_id FROM crawler_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 10").all();

console.log(`Found ${queuedJobs.length} queued jobs (processing first 10)\n`);

for (const job of queuedJobs) {
  const profile = db.prepare('SELECT display_name FROM profiles WHERE id = ?').get(job.profile_id);
  console.log(`Dispatching: ${job.type} for ${profile?.display_name || job.profile_id}`);
  
  try {
    dispatchCrawlerJob({
      db,
      jobId: job.id,
      uploadDir,
      getOpenAI
    });
    console.log(`  ✓ Dispatched`);
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }
}

// Wait a bit and check status
console.log('\nWaiting 5 seconds for jobs to start...');
await new Promise(r => setTimeout(r, 5000));

const running = db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'running'").get().c;
const completed = db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'completed'").get().c;
const failed = db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'failed'").get().c;
const queued = db.prepare("SELECT COUNT(*) as c FROM crawler_jobs WHERE status = 'queued'").get().c;

console.log('\n=== CURRENT STATUS ===');
console.log(`Queued: ${queued}`);
console.log(`Running: ${running}`);
console.log(`Completed: ${completed}`);
console.log(`Failed: ${failed}`);

db.close();
