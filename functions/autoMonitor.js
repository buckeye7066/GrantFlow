import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createLogger } from './_shared/logger.js';

// Base44 integration: Use centralized logger
const logger = createLogger('autoMonitor');

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;

    const [pending, running] = await Promise.all([
      sdk.entities.ProcessingQueue.filter({ status: 'pending' }),
      sdk.entities.ProcessingQueue.filter({ status: 'running' })
    ]);

    const stats = { pending: pending?.length || 0, running: running?.length || 0 };
    // Base44 integration: Debug log only in development
    logger.debug(`[${requestId}] Queue: ${stats.pending} pending, ${stats.running} running`);

    if (stats.pending === 0 && stats.running === 0) {
      return Response.json({ ok: true, result: { message: 'No jobs to process', stats } });
    }

    let workerResult = null;
    try {
      const response = await sdk.functions.invoke('backgroundWorker', {});
      workerResult = response?.data ?? null;
    } catch (e) {
      workerResult = { error: e.message };
    }

    return Response.json({ ok: true, result: { worker: workerResult, stats } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});