import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

async function enqueue(sdk, profileId, grantId) {
  const existing = await sdk.entities.ProcessingQueue.filter({ profile_id: profileId, grant_id: grantId, status: 'pending' });
  if (existing?.length) return { job_id: existing[0].id, already_queued: true };

  const running = await sdk.entities.ProcessingQueue.filter({ profile_id: profileId, grant_id: grantId, status: 'running' });
  if (running?.length) return { job_id: running[0].id, already_running: true };

  const job = await sdk.entities.ProcessingQueue.create({ profile_id: profileId, grant_id: grantId, status: 'pending', attempts: 0 });
  return { job_id: job.id, created: true, ok: true };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { action, profile_id, grant_id, grant_ids, _selfTest } = body;

    if (_selfTest) return Response.json({ ok: true, testMode: true });
    if (action === 'stats') {
      const [pending, running] = await Promise.all([
        sdk.entities.ProcessingQueue.filter({ status: 'pending' }),
        sdk.entities.ProcessingQueue.filter({ status: 'running' })
      ]);
      return Response.json({ ok: true, result: { pending: pending?.length || 0, running: running?.length || 0 } });
    }
    if (!profile_id) return Response.json({ ok: false, error: 'Missing profile_id' }, { status: 400 });

    if (grant_ids?.length) {
      let queued = 0, skipped = 0;
      for (const gid of grant_ids) {
        const r = await enqueue(sdk, profile_id, gid);
        if (r.created) queued++; else skipped++;
      }
      return Response.json({ ok: true, queued, skipped, total: grant_ids.length });
    }

    if (!grant_id) return Response.json({ ok: false, error: 'Missing grant_id' }, { status: 400 });
    return Response.json({ ok: true, result: await enqueue(sdk, profile_id, grant_id) });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});