import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { getSafeSDK, assertNotUserSuppliedAuthId, enforceOwnership } from './_shared/security.js';
import { resolveGrantId } from './_utils/resolveEntityId.js';

Deno.serve(async (req) => {
  try {
    const { sdk, user } = await getSafeSDK(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { grant_id: rawGrantId, report_type, reporting_period_start, reporting_period_end, sections } = await req.json();
    assertNotUserSuppliedAuthId('grant_id', rawGrantId, 'generateProgressReport');
    if (!rawGrantId) return Response.json({ error: 'grant_id is required' }, { status: 400 });

    const grant_id = await resolveGrantId(sdk, rawGrantId);
    const grant = await sdk.entities.Grant.get(grant_id);
    if (!grant) return Response.json({ error: 'Grant not found' }, { status: 404 });
    enforceOwnership(user, grant, 'created_by');

    const organization = await sdk.entities.Organization.get(grant.organization_id);
    const [kpis, expenses, milestones] = await Promise.all([
      sdk.entities.GrantKPI.filter({ grant_id }),
      sdk.entities.Expense.filter({ grant_id }),
      sdk.entities.Milestone.filter({ grant_id })
    ]);

    const sectionsToGenerate = sections || ['executive_summary', 'activities_summary', 'progress_toward_goals', 'financial_summary', 'challenges_and_solutions', 'next_steps'];
    const reportSections = {};
    
    for (const section of sectionsToGenerate) {
      const response = await sdk.integrations.Core.InvokeLLM({
        prompt: `Generate ${section} for grant: ${grant.title}, org: ${organization.name}`,
        add_context_from_internet: false
      });
      reportSections[section] = response;
    }

    const report = await sdk.entities.ComplianceReport.create({
      grant_id, organization_id: organization.id, report_type: report_type || 'progress',
      reporting_period_start, reporting_period_end,
      report_narrative: Object.entries(reportSections).map(([s, c]) => `## ${s}\n\n${c}`).join('\n\n'),
      status: 'draft'
    });

    return Response.json({ success: true, report_id: report.id, sections: reportSections });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});