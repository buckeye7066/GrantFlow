import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Check Grant Alerts - Automated deadline and status monitoring
Deno.serve(async (req) => {
  try {
    const sdk = createClientFromRequest(req).asServiceRole;
    const body = await req.json().catch(() => ({}));
    const { organization_id } = body;

    const alertConfigs = organization_id 
      ? await sdk.entities.GrantAlert.filter({ organization_id, enabled: true })
      : await sdk.entities.GrantAlert.filter({ enabled: true });

    let sent = 0, skipped = 0, failed = 0;

    for (const config of alertConfigs) {
      const grants = await sdk.entities.Grant.filter({ organization_id: config.organization_id });
      const org = await sdk.entities.Organization.get(config.organization_id);
      if (!org) continue;

      const now = new Date();
      const threshold = config.deadline_threshold_days || 14;

      for (const grant of grants) {
        if (!['discovered', 'interested', 'drafting', 'portal', 'application_prep'].includes(grant.status)) continue;
        if (!grant.deadline || grant.deadline.toLowerCase() === 'rolling') continue;

        const daysUntil = Math.floor((new Date(grant.deadline) - now) / (1000 * 60 * 60 * 24));
        if (daysUntil < 0 || daysUntil > threshold) continue;

        const severity = daysUntil <= 3 ? 'critical' : daysUntil <= 7 ? 'high' : 'medium';
        const urgency = daysUntil <= 3 ? '🚨 URGENT' : daysUntil <= 7 ? '⚠️ IMPORTANT' : '📅';

        await sdk.entities.GrantMonitoringLog.create({
          grant_id: grant.id, organization_id: grant.organization_id, event_type: 'deadline_approaching',
          event_data: JSON.stringify({ days_until: daysUntil, deadline: grant.deadline }), severity, alert_sent: true
        });

        if (config.notification_method.includes('email')) {
          await sdk.integrations.Core.SendEmail({
            to: org.created_by,
            subject: `${urgency}: Deadline in ${daysUntil} days - ${grant.title}`,
            body: `Grant "${grant.title}" deadline: ${grant.deadline}. ${daysUntil} days remaining. Status: ${grant.status}.`
          });
          sent++;
        }
      }
      await sdk.entities.GrantAlert.update(config.id, { last_check: new Date().toISOString() });
    }

    return Response.json({ success: true, alerts_sent: sent, alerts_failed: failed, alerts_skipped: skipped });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});