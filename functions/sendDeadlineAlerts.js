import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { getSafeSDK, enforceOwnership } from './_shared/security.js';

Deno.serve(async (req) => {
  try {
    const { sdk, user } = await getSafeSDK(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { organization_id } = await req.json().catch(() => ({}));
    if (organization_id) {
      const org = await sdk.entities.Organization.get(organization_id);
      if (!org) return Response.json({ error: 'Not found' }, { status: 404 });
      enforceOwnership(user, org, 'created_by');
    }

    const now = new Date();
    const alerts = [];
    
    let milestones = await sdk.entities.Milestone.filter({ completed: false });
    if (organization_id) {
      const grants = await sdk.entities.Grant.filter({ organization_id });
      const grantIds = new Set(grants.map(g => g.id));
      milestones = milestones.filter(m => grantIds.has(m.grant_id));
    }

    for (const milestone of milestones) {
      const daysUntil = Math.ceil((new Date(milestone.due_date) - now) / (1000 * 60 * 60 * 24));
      if ([14, 7, 3, 1].includes(daysUntil)) {
        const grant = await sdk.entities.Grant.get(milestone.grant_id);
        const org = await sdk.entities.Organization.get(grant.organization_id);
        
        await sdk.integrations.Core.SendEmail({
          to: org.created_by, subject: '⏰ Reminder: ' + milestone.title + ' - ' + daysUntil + ' days',
          body: 'Deadline reminder for ' + grant.title + '. Milestone: ' + milestone.title + '. Due in ' + daysUntil + ' days.'
        });
        
        alerts.push({ organization: org.name, grant: grant.title, milestone: milestone.title, days_until: daysUntil });
      }
    }

    return Response.json({ success: true, alerts_sent: alerts.length, alerts });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});