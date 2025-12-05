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

    const kpiSummary = (kpis ?? [])
      .map((kpi) => {
        const label = kpi.metric ?? kpi.name ?? `KPI ${kpi.id}`;
        const current = kpi.current_value ?? kpi.value ?? kpi.status ?? 'n/a';
        return `${label}: ${current}`;
      })
      .slice(0, 10)
      .join('\n');

    const expenseSummary = (expenses ?? [])
      .map((expense) => {
        const category = expense.category ?? expense.type ?? 'Expense';
        const amount = expense.amount ?? expense.total ?? 'n/a';
        return `${category}: ${amount}`;
      })
      .slice(0, 10)
      .join('\n');

    const milestoneSummary = (milestones ?? [])
      .map((milestone) => {
        const name = milestone.name ?? milestone.title ?? `Milestone ${milestone.id}`;
        const status = milestone.status ?? milestone.state ?? 'unknown';
        const date = milestone.completed_at ?? milestone.due_date ?? milestone.target_date ?? '';
        return `${name}: ${status}${date ? ` (${date})` : ''}`;
      })
      .slice(0, 10)
      .join('\n');

    const analysisContext = [
      `Grant: ${grant.title}`,
      `Organization: ${organization.name}`,
      grant.award_amount ? `Award Amount: ${grant.award_amount}` : null,
      grant.status ? `Grant Status: ${grant.status}` : null,
      kpiSummary ? `KPIs:\n${kpiSummary}` : null,
      expenseSummary ? `Expenses:\n${expenseSummary}` : null,
      milestoneSummary ? `Milestones:\n${milestoneSummary}` : null
    ]
      .filter(Boolean)
      .join('\n\n');

    const sectionsToGenerate = sections || ['executive_summary', 'activities_summary', 'progress_toward_goals', 'financial_summary', 'challenges_and_solutions', 'next_steps'];
    const reportSections = {};
    
    for (const section of sectionsToGenerate) {
      const response = await sdk.integrations.Core.InvokeLLM({
        prompt: `Generate the ${section} section for the compliance report.\n\n${analysisContext}`,
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