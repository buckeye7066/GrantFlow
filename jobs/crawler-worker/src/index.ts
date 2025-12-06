import 'dotenv/config';
import { Worker } from 'bullmq';
import { processGrantJob } from './tasks/processGrant';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

const worker = new Worker(
  'grant-pipeline',
  async (job) => {
    if (job.name === 'processGrant') {
      await processGrantJob(job.data);
    }
  },
  {
    connection: { url: redisUrl },
  },
);

worker.on('ready', () => {
  console.log('[crawler-worker] ready');
});

worker.on('completed', (job) => {
  console.log(`[crawler-worker] job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[crawler-worker] job ${job?.id} failed: ${err.message}`);
});

