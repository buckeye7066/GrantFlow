import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Get Background Job Status - Query job progress
Deno.serve(async (req) => {
  try {
    const sdk = createClientFromRequest(req).asServiceRole;
    const body = await req.json().catch(() => ({}));
    const { job_id } = body;

    if (!job_id) return Response.json({ success: false, error: 'job_id required' }, { status: 400 });

    const jobs = await sdk.entities.JobStatus.filter({ job_id });
    if (!jobs || jobs.length === 0) {
      return Response.json({ success: true, status: 'idle', progress: 0, message: 'No active job' });
    }

    const job = jobs[0];
    return Response.json({
      success: true, status: job.status || 'unknown', progress: job.progress || 0,
      total_grants: job.total_grants || 0, grants_processed: job.grants_processed || 0,
      current_operation: job.current_operation, current_grant_title: job.current_grant_title,
      stats: job.stats || {}, results: job.results || {}, error: job.error
    });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});