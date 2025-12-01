import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });

    const body = await req.json();
    const { report_id } = body;
    if (!report_id) return Response.json({ success: false, error: { code: 'MISSING_FIELDS', message: 'report_id required' } }, { status: 400 });

    const sdk = base44.asServiceRole;
    const report = await sdk.entities.ComplianceReport.get(report_id);
    if (!report) return Response.json({ success: false, error: { code: 'NOT_FOUND', message: 'Report not found' } }, { status: 404 });

    const isAdmin = user.email === 'buckeye7066@gmail.com';
    if (!isAdmin && report.created_by !== user.email) return Response.json({ success: false, error: { code: 'UNAUTHORIZED' } }, { status: 403 });

    const [grant, organization, budgetItems, expenses, milestones] = await Promise.all([
      sdk.entities.Grant.get(report.grant_id),
      sdk.entities.Organization.get(report.organization_id),
      sdk.entities.Budget.filter({ grant_id: report.grant_id }),
      sdk.entities.Expense.filter({ grant_id: report.grant_id }),
      sdk.entities.Milestone.filter({ grant_id: report.grant_id })
    ]);

    const totalBudget = budgetItems.reduce((sum, item) => sum + (item.total || 0), 0);
    const totalSpent = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
    const completedMilestones = milestones.filter(m => m.completed).length;

    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Generate compliance report for grant: ' + grant.title + '. Budget: $' + totalBudget + ', Spent: $' + totalSpent + ', Milestones: ' + completedMilestones + '/' + milestones.length,
      response_json_schema: { type: "object", properties: { narrative: { type: "string" }, activities_summary: { type: "string" }, financial_summary: { type: "string" } } }
    });

    const updated = await sdk.entities.ComplianceReport.update(report_id, { narrative: aiResponse.narrative, activities_summary: aiResponse.activities_summary, status: 'draft' });
    return Response.json({ success: true, report: updated });
  } catch (error) {
    return Response.json({ success: false, error: { code: 'UNEXPECTED_ERROR', message: error.message } }, { status: 500 });
  }
});