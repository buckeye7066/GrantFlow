import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { getSafeSDK, enforceOwnership } from './_shared/security.js';
import { resolveGrantId } from './_utils/resolveEntityId.js';

Deno.serve(async (req) => {
  try {
    const { sdk, user } = await getSafeSDK(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { grant_id: rawGrantId, report_type, reporting_period_start, reporting_period_end, sections } = await req.json();
    if (!rawGrantId) return Response.json({ error: 'grant_id required' }, { status: 400 });

    const grant_id = await resolveGrantId(sdk, rawGrantId);
    const grant = await sdk.entities.Grant.get(grant_id);
    if (!grant) return Response.json({ error: 'Grant not found' }, { status: 404 });

    enforceOwnership(user, grant, 'created_by');

    const [organization, kpis, expenses, milestones] = await Promise.all([
      sdk.entities.Organization.get(grant.organization_id),
      sdk.entities.GrantKPI.filter({ grant_id }),
      sdk.entities.Expense.filter({ grant_id }),
      sdk.entities.Milestone.filter({ grant_id })
    ]);

    const reportSections = {};
    for (const section of (sections || ['executive_summary', 'activities_summary', 'financial_summary'])) {
      const response = await sdk.integrations.Core.InvokeLLM({
        prompt: 'Write ' + section + ' section for progress report. Grant: ' + grant.title + '. KPIs: ' + kpis.length + '. Expenses: $' + expenses.reduce((s, e) => s + e.amount, 0),
        add_context_from_internet: false
      });
      reportSections[section] = response;
    }

    const report = await sdk.entities.ComplianceReport.create({
      grant_id, organization_id: organization.id, report_type: report_type || 'progress',
      reporting_period_start, reporting_period_end,
      report_narrative: Object.entries(reportSections).map(([s, c]) => '## ' + s.toUpperCase() + '\n\n' + c).join('\n\n'),
      status: 'draft'
    });

    return Response.json({ success: true, report_id: report.id, sections: reportSections });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});