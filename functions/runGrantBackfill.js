import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Run Grant Backfill - Batch AI analysis for unprocessed grants
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const grants = await sdk.entities.Grant.list();
    const organizations = await sdk.entities.Organization.list();

    const grantsToProcess = grants.filter(g => !g.ai_summary || !g.ai_status || g.ai_status === 'error');
    if (grantsToProcess.length === 0) return Response.json({ message: 'No grants need processing', totalGrants: 0 });

    const job = await sdk.entities.SearchJob.create({
      profile_id: 'backfill_' + Date.now(), status: 'running', progress: 0,
      filters: JSON.stringify({ type: 'grant_backfill', total: grantsToProcess.length })
    });

    (async () => {
      let processed = 0;
      for (const grant of grantsToProcess) {
        const org = organizations.find(o => o.id === grant.organization_id);
        if (!org) continue;

        try {
          await sdk.entities.Grant.update(grant.id, { ai_status: 'running' });
          const result = await sdk.integrations.Core.InvokeLLM({
            prompt: `Analyze grant "${grant.title}" for "${org.name}". Provide match_score 0-100 and summary.`,
            response_json_schema: { type: "object", properties: { match_score: { type: "number" }, summary: { type: "string" } } }
          });
          await sdk.entities.Grant.update(grant.id, { ai_summary: result.summary, ai_status: 'ready', match_score: result.match_score });
          processed++;
          await sdk.entities.SearchJob.update(job.id, { progress: processed / grantsToProcess.length });
        } catch (e) {
          await sdk.entities.Grant.update(grant.id, { ai_status: 'error', ai_error: e.message });
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      await sdk.entities.SearchJob.update(job.id, { status: 'done', progress: 1 });
    })();

    return Response.json({ message: 'Backfill started', jobId: job.id, totalGrants: grantsToProcess.length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});