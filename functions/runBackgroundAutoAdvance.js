import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Run Background Auto Advance - Automated pipeline progression
const ELIGIBLE_STATUSES = ['discovered', 'interested', 'drafting', 'application_prep', 'revision'];
const STATUS_PROGRESSION = { discovered: 'interested', interested: 'drafting', drafting: 'application_prep', application_prep: 'revision', revision: 'submitted' };

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHENTICATED' }, { status: 401 });

    const sdk = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const { organization_id, profile_id } = body;

    const job = await sdk.entities.JobStatus.create({ job_id: 'auto-adv-' + Date.now(), status: 'running', progress: 0 });

    (async () => {
      const filter = organization_id && profile_id ? { organization_id, profile_id } : organization_id ? { organization_id } : {};
      const allGrants = await sdk.entities.Grant.filter(filter);
      const eligible = allGrants.filter(g => ELIGIBLE_STATUSES.includes(g.status));

      let processed = 0, analyzed = 0, advanced = 0;
      for (const grant of eligible) {
        if (!grant.ai_summary) {
          await sdk.entities.Grant.update(grant.id, { ai_status: 'running' });
          try {
            const result = await sdk.integrations.Core.InvokeLLM({
              prompt: `Analyze grant "${grant.title}". Provide match_score 0-100 and summary.`,
              response_json_schema: { type: "object", properties: { match_score: { type: "number" }, summary: { type: "string" } } }
            });
            await sdk.entities.Grant.update(grant.id, { ai_summary: result.summary, ai_status: 'ready', match_score: result.match_score });
            analyzed++;
          } catch (e) {
            await sdk.entities.Grant.update(grant.id, { ai_status: 'error', ai_error: e.message });
          }
        }

        const settings = (await sdk.entities.AutomationSettings.filter({ organization_id: grant.organization_id }))[0];
        const nextStatus = STATUS_PROGRESSION[grant.status];
        if (settings?.auto_advance_enabled && nextStatus) {
          await sdk.entities.Grant.update(grant.id, { status: nextStatus });
          advanced++;
        }

        processed++;
        await sdk.entities.JobStatus.update(job.id, { progress: processed / eligible.length });
      }

      await sdk.entities.JobStatus.update(job.id, { status: 'completed', progress: 1, results: { analyzed, advanced } });
    })();

    return Response.json({ ok: true, data: { job_id: job.job_id, message: 'Auto-advance started' } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});