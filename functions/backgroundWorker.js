import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Background Worker - Queue processor for grant analysis
const LOCK_TIMEOUT_MS = 60000;

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;

    let body = {};
    try { const text = await req.text(); if (text) body = JSON.parse(text); } catch (e) {}

    if (body.action === 'stats') {
      const [pending, running, completed, failed] = await Promise.all([
        sdk.entities.ProcessingQueue.filter({ status: 'pending' }),
        sdk.entities.ProcessingQueue.filter({ status: 'running' }),
        sdk.entities.ProcessingQueue.filter({ status: 'completed' }),
        sdk.entities.ProcessingQueue.filter({ status: 'failed' })
      ]);
      return Response.json({ ok: true, result: { pending: pending?.length || 0, running: running?.length || 0, completed: completed?.length || 0, failed: failed?.length || 0 } });
    }

    const pendingJobs = await sdk.entities.ProcessingQueue.filter({ status: 'pending' });
    if (!pendingJobs || pendingJobs.length === 0) return Response.json({ ok: true, result: { message: 'no-jobs' } });

    pendingJobs.sort((a, b) => new Date(a.created_date) - new Date(b.created_date));
    const job = pendingJobs[0];

    await sdk.entities.ProcessingQueue.update(job.id, { status: 'running', started_at: new Date().toISOString() });

    try {
      const grant = await sdk.entities.Grant.get(job.grant_id);
      const profile = await sdk.entities.Organization.get(job.profile_id);
      await sdk.entities.Grant.update(job.grant_id, { ai_status: 'running' });

      const result = await sdk.integrations.Core.InvokeLLM({
        prompt: `Analyze grant "${grant.title}" for applicant "${profile?.name}". Provide match_score 0-100.`,
        response_json_schema: { type: "object", properties: { match_score: { type: "number" }, summary: { type: "string" } } }
      });

      await sdk.entities.Grant.update(job.grant_id, { ai_status: 'ready', ai_summary: result.summary, match_score: result.match_score || 50 });
      await sdk.entities.ProcessingQueue.update(job.id, { status: 'completed', completed_at: new Date().toISOString() });

      return Response.json({ ok: true, result: { job_id: job.id, grant_id: job.grant_id, match_score: result.match_score } });
    } catch (processError) {
      await sdk.entities.ProcessingQueue.update(job.id, { status: 'failed', error_message: processError.message });
      return Response.json({ ok: true, result: { job_id: job.id, error: processError.message } });
    }
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});