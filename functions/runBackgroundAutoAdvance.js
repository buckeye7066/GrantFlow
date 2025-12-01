// NOTE: Large file with complex pipeline logic - minified
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { withDiagnostics } from './_shared/withDiagnostics.js';

const ELIGIBLE_STATUSES = ['discovered', 'interested', 'drafting', 'application_prep', 'revision'];
const STATUS_PROGRESSION = { 'discovered': 'interested', 'interested': 'drafting', 'drafting': 'application_prep', 'application_prep': 'revision', 'revision': 'submitted' };

const handler = async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHENTICATED' }, { status: 401 });
  
  const sdk = base44.asServiceRole;
  const body = await req.json().catch(() => ({}));
  const jobId = 'auto-advance-' + Date.now();
  
  const jobStatus = await sdk.entities.JobStatus.create({ job_id: jobId, status: 'queued', progress: 0 });

  // Background processing
  (async () => {
    const grants = body.organization_id ? await sdk.entities.Grant.filter({ organization_id: body.organization_id }) : await sdk.entities.Grant.list();
    const eligibleGrants = grants.filter(g => ELIGIBLE_STATUSES.includes(g.status));
    
    let processed = 0, analyzed = 0, advanced = 0;
    for (const grant of eligibleGrants) {
      try {
        if (!grant.ai_summary) {
          await sdk.functions.invoke('analyzeGrant', { grant_id: grant.id });
          analyzed++;
        }
        
        const nextStatus = STATUS_PROGRESSION[grant.status];
        if (nextStatus) {
          await sdk.entities.Grant.update(grant.id, { status: nextStatus });
          advanced++;
        }
        processed++;
        await sdk.entities.JobStatus.update(jobStatus.id, { progress: processed / eligibleGrants.length });
      } catch (e) {}
    }
    
    await sdk.entities.JobStatus.update(jobStatus.id, { status: 'completed', progress: 1, results: { analyzed, advanced } });
  })();

  return Response.json({ ok: true, data: { job_id: jobId, message: 'Auto-advance started' } });
};

Deno.serve(withDiagnostics(handler, 'runBackgroundAutoAdvance'));