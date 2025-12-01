import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const sdk = createClientFromRequest(req).asServiceRole;
    const today = new Date();
    
    const allReports = await sdk.entities.ComplianceReport.filter({ status: { $in: ['scheduled', 'draft'] } });
    if (allReports.length === 0) return Response.json({ success: true, message: 'No pending reports', reminders_sent: 0 });

    const results = [];
    for (const report of allReports) {
      const due = new Date(report.due_date);
      const daysUntil = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
      
      if ([30, 14, 7, 3, 1].includes(daysUntil) || daysUntil < 0) {
        const [grant, organization] = await Promise.all([
          sdk.entities.Grant.get(report.grant_id),
          sdk.entities.Organization.get(report.organization_id)
        ]);
        
        if (grant && organization && organization.created_by) {
          try {
            await sdk.integrations.Core.SendEmail({
              to: organization.created_by,
              subject: (daysUntil < 0 ? '🚨 OVERDUE' : '📅') + ' Report: ' + grant.title,
              body: 'Report due in ' + daysUntil + ' days for grant: ' + grant.title
            });
            await sdk.entities.ComplianceReport.update(report.id, { reminder_sent: true, reminder_sent_date: new Date().toISOString() });
            results.push({ sent: true, reportId: report.id, daysUntil });
          } catch (e) {
            results.push({ success: false, reportId: report.id });
          }
        }
      }
    }

    return Response.json({ success: true, total_pending: allReports.length, reminders_sent: results.filter(r => r.sent).length, results });
  } catch (error) {
    return Response.json({ success: false, error: { code: 'UNEXPECTED_ERROR', message: error.message } }, { status: 500 });
  }
});