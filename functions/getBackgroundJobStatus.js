import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const { job_id } = body;
    
    if (!job_id) return Response.json({ success: false, error: 'job_id required' }, { status: 400 });

    const jobs = await sdk.entities.JobStatus.filter({ job_id });
    if (!jobs?.length) return Response.json({ success: true, status: 'idle', progress: 0, message: 'No job found' });

    const job = jobs[0];
    return Response.json({ success: true, status: job.status || 'unknown', progress: job.progress || 0, total_grants: job.total_grants, grants_processed: job.grants_processed, stats: job.stats || {}, results: job.results || {} });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});