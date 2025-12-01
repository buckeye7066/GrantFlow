import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Send Report Reminders - Scheduled job for deadline notifications
Deno.serve(async (req) => {
  try {
    const sdk = createClientFromRequest(req).asServiceRole;
    const today = new Date();

    const allReports = await sdk.entities.ComplianceReport.filter({ status: { $in: ['scheduled', 'draft'] } });
    if (allReports.length === 0) return Response.json({ success: true, message: 'No pending reports', reminders_sent: 0 });

    const thresholds = [30, 14, 7, 3, 1];
    let sent = 0, skipped = 0;

    for (const report of allReports) {
      const dueDate = new Date(report.due_date);
      const daysUntil = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
      const isThreshold = thresholds.includes(daysUntil) || daysUntil < 0;

      if (!isThreshold) { skipped++; continue; }
      if (report.reminder_sent_date && new Date(report.reminder_sent_date).toDateString() === today.toDateString()) { skipped++; continue; }

      const grant = await sdk.entities.Grant.get(report.grant_id);
      const org = await sdk.entities.Organization.get(report.organization_id);
      if (!grant || !org) continue;

      const urgency = daysUntil < 0 ? '🚨 OVERDUE' : daysUntil <= 3 ? '⚠️ URGENT' : '📅 Reminder';
      const subject = `${urgency}: ${grant.title} - ${report.report_type.toUpperCase()} Report`;
      const body = `Report for ${grant.title} is due ${daysUntil < 0 ? Math.abs(daysUntil) + ' days ago' : 'in ' + daysUntil + ' days'}. Log in to GrantFlow to submit.`;

      await sdk.integrations.Core.SendEmail({ to: org.created_by, subject, body });
      await sdk.entities.ComplianceReport.update(report.id, { reminder_sent: true, reminder_sent_date: today.toISOString() });
      sent++;
    }

    return Response.json({ success: true, total_pending: allReports.length, reminders_sent: sent, reminders_skipped: skipped });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});