import 'dotenv/config';
import cron from 'node-cron';
import { Queue } from 'bullmq';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const grantPipelineQueue = new Queue('grant-pipeline', {
  connection: { url: redisUrl },
});

async function enqueueNightlyMatches() {
  await grantPipelineQueue.add(
    'smartAutomation',
    { reason: 'nightly-match-refresh' },
    { removeOnComplete: true },
  );
  console.log('[scheduler] queued smartAutomation job');
}

async function enqueueLocalDiscovery() {
  await grantPipelineQueue.add(
    'localCrawler',
    { reason: 'nightly-local-discovery' },
    { removeOnComplete: true },
  );
  console.log('[scheduler] queued local discovery');
}

cron.schedule('0 2 * * *', enqueueNightlyMatches); // 2 AM daily
cron.schedule('30 2 * * *', enqueueLocalDiscovery); // 2:30 AM daily

console.log('[scheduler] running cron jobs');

