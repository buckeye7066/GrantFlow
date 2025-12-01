import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const { organization_id } = body;
    
    const alertConfigs = organization_id 
      ? await sdk.entities.GrantAlert.filter({ organization_id, enabled: true })
      : await sdk.entities.GrantAlert.filter({ enabled: true });
    
    const alertsSent = [];
    const now = new Date();
    
    for (const config of alertConfigs) {
      const grants = await sdk.entities.Grant.filter({ organization_id: config.organization_id });
      const organization = await sdk.entities.Organization.get(config.organization_id);
      
      if (config.alert_type === 'deadline_approaching') {
        const threshold = config.deadline_threshold_days || 14;
        for (const grant of grants) {
          if (!grant.deadline || grant.deadline === 'rolling') continue;
          const daysUntil = Math.floor((new Date(grant.deadline) - now) / (1000 * 60 * 60 * 24));
          
          if (daysUntil >= 0 && daysUntil <= threshold && ['discovered', 'interested', 'drafting'].includes(grant.status)) {
            try {
              await sdk.integrations.Core.SendEmail({
                to: organization.created_by,
                subject: (daysUntil <= 3 ? '🚨' : '⚠️') + ' Deadline: ' + grant.title,
                body: 'Grant deadline in ' + daysUntil + ' days'
              });
              alertsSent.push({ grant_id: grant.id, days: daysUntil });
            } catch (e) {}
          }
        }
      }
      
      await sdk.entities.GrantAlert.update(config.id, { last_check: new Date().toISOString() });
    }
    
    return Response.json({ success: true, alerts_sent: alertsSent.length });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});