import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Auto Generate Bulk Outreach - Batch outreach message generation
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const user = { id: 'public', email: 'public@grantflow.app', full_name: 'Public User' };
    const body = await req.json();
    const { organization_id, grant_ids, outreach_type = 'inquiry', auto_send = false } = body;
    if (!organization_id) return Response.json({ error: 'organization_id required' }, { status: 400 });

    const organization = await sdk.entities.Organization.get(organization_id);
    if (!organization) return Response.json({ error: 'Organization not found' }, { status: 404 });

    let grants = grant_ids?.length > 0 ? await Promise.all(grant_ids.map(id => sdk.entities.Grant.get(id))) : await sdk.entities.Grant.filter({ organization_id, status: { $in: ['discovered', 'interested'] } });
    let generated = 0, saved = 0, sent = 0;

    for (const grant of grants) {
      const existing = await sdk.entities.OutreachCampaign.filter({ organization_id, grant_id: grant.id });
      if (existing.length > 0) continue;

      const msgResp = await sdk.functions.invoke('generateOutreachMessage', { organization_id, grant_id: grant.id, funder_name: grant.funder, outreach_type });
      if (!msgResp.data?.success) continue;
      
      generated++;
      const data = msgResp.data;
      await sdk.entities.OutreachCampaign.create({ organization_id, grant_id: grant.id, funder_name: grant.funder, outreach_type, subject_line: data.subject_line, message_body: data.message_body, ai_generated: true, status: auto_send ? 'sent' : 'ready_to_send' });
      saved++;
      
      if (auto_send && grant.funder_email) {
        await sdk.integrations.Core.SendEmail({ to: grant.funder_email, from_name: organization.name, subject: data.subject_line, body: data.message_body });
        sent++;
      }
    }

    return Response.json({ success: true, total: grants.length, generated, saved, sent });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});