import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const processGrantWithRetry = async (grant, org, base44, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await base44.asServiceRole.entities.Grant.update(grant.id, { ai_status: 'running' });
      
      const analysisResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: 'Analyze grant for ' + org.name + '. Grant: ' + grant.title + ', Funder: ' + grant.funder,
        response_json_schema: { type: "object", properties: { analysis_markdown: { type: "string" } } }
      });
      
      await base44.asServiceRole.entities.Grant.update(grant.id, { ai_summary: analysisResult.analysis_markdown, ai_status: 'ready' });
      return { success: true };
    } catch (error) {
      if (attempt === maxRetries) {
        await base44.asServiceRole.entities.Grant.update(grant.id, { ai_status: 'error', ai_error: error.message });
        throw error;
      }
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const grants = await base44.asServiceRole.entities.Grant.list();
    const organizations = await base44.asServiceRole.entities.Organization.list();
    const grantsToProcess = grants.filter(g => !g.ai_summary || g.ai_status === 'idle');
    
    if (grantsToProcess.length === 0) return Response.json({ message: 'No grants need processing', totalGrants: 0 });

    const job = await base44.asServiceRole.entities.SearchJob.create({ profile_id: 'backfill_' + Date.now(), status: 'running', progress: 0 });

    (async () => {
      let processed = 0;
      for (const grant of grantsToProcess) {
        const org = organizations.find(o => o.id === grant.organization_id);
        if (!org) continue;
        try {
          await processGrantWithRetry(grant, org, base44);
          processed++;
          await base44.asServiceRole.entities.SearchJob.update(job.id, { progress: processed / grantsToProcess.length });
        } catch (e) {}
        await sleep(2000);
      }
      await base44.asServiceRole.entities.SearchJob.update(job.id, { status: 'done', progress: 1 });
    })();

    return Response.json({ message: 'Grant backfill started', jobId: job.id, totalGrants: grantsToProcess.length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});