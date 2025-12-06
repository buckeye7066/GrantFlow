import { Queue } from 'bullmq';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

const grantPipelineQueue = new Queue('grant-pipeline', {
  connection: { url: redisUrl },
});

type RunInput = {
  queue: ('smartAutomation' | 'autoAdvance' | 'localCrawler')[];
  payload?: Record<string, unknown>;
};

export const automationRunner = {
  async run(input: RunInput) {
    const payload = input.payload ?? {};
    const results = [];

    for (const name of input.queue) {
      const job = await grantPipelineQueue.add(name, payload, {
        removeOnComplete: true,
        removeOnFail: false,
      });
      results.push({ queue: name, jobId: job.id });
    }

    return { queued: results };
  },
};

