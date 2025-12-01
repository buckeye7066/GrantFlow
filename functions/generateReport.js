import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Generate Report - AI-powered compliance report generation
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const user = await base44.auth.me();
    if (!user) return Response.json({ success: false, error: { code: 'UNAUTHORIZED' } }, { status: 401 });

    const body = await req.json();
    const { report_id } = body;
    if (!report_id) return Response.json({ success: false, error: { code: 'MISSING_REPORT_ID' } }, { status: 400 });

    const report = await sdk.entities.ComplianceReport.get(report_id);
    if (!report) return Response.json({ success: false, error: { code: 'REPORT_NOT_FOUND' } }, { status: 404 });

    const grant = await sdk.entities.Grant.get(report.grant_id);
    const organization = await sdk.entities.Organization.get(report.organization_id);
    const [budgetItems, expenses, milestones] = await Promise.all([
      sdk.entities.Budget.filter({ grant_id: grant.id }),
      sdk.entities.Expense.filter({ grant_id: grant.id }),
      sdk.entities.Milestone.filter({ grant_id: grant.id })
    ]);

    const totalBudget = budgetItems.reduce((sum, item) => sum + (item.total || 0), 0);
    const totalSpent = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
    const completedMilestones = milestones.filter(m => m.completed).length;

    const prompt = `Generate a ${report.report_type} compliance report for grant "${grant.title}" by ${grant.funder}.
Organization: ${organization.name}. Budget: $${totalBudget}, Spent: $${totalSpent}. Milestones: ${completedMilestones}/${milestones.length}.
Provide: narrative, activities_summary, financial_summary, impact_metrics, challenges_faced, next_steps.`;

    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: { type: "object", properties: { narrative: { type: "string" }, activities_summary: { type: "string" }, financial_summary: { type: "string" }, impact_metrics: { type: "string" }, challenges_faced: { type: "string" }, next_steps: { type: "string" } } }
    });

    const updatedReport = await sdk.entities.ComplianceReport.update(report_id, {
      narrative: aiResponse.narrative, activities_summary: aiResponse.activities_summary, financial_data: JSON.stringify({ total_budget: totalBudget, total_spent: totalSpent }), status: 'draft'
    });

    return Response.json({ success: true, report: updatedReport });
  } catch (error) {
    return Response.json({ success: false, error: { code: 'UNEXPECTED_ERROR', message: error.message } }, { status: 500 });
  }
});