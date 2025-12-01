import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { organization_id, grant_ids, outreach_type = 'inquiry', auto_send = false } = body;
    if (!organization_id) return Response.json({ error: 'organization_id required' }, { status: 400 });

    const organization = await sdk.entities.Organization.get(organization_id);
    if (!organization) return Response.json({ error: 'Not found' }, { status: 404 });

    let grants = [];
    if (grant_ids?.length) {
      for (const gid of grant_ids) {
        const g = await sdk.entities.Grant.get(gid);
        if (g) grants.push(g);
      }
    } else {
      grants = await sdk.entities.Grant.filter({ organization_id, status: { $in: ['discovered', 'interested'] } });
    }

    const results = { total: grants.length, generated: 0, saved: 0, sent: 0, failed: 0, campaigns: [] };

    for (const grant of grants) {
      try {
        const existing = await sdk.entities.OutreachCampaign.filter({ organization_id, grant_id: grant.id });
        if (existing.length > 0) continue;

        const msgResp = await sdk.functions.invoke('generateOutreachMessage', { organization_id, grant_id: grant.id, funder_name: grant.funder, outreach_type });
        if (!msgResp.data?.success) { results.failed++; continue; }

        results.generated++;
        const data = msgResp.data;

        const campaign = await sdk.entities.OutreachCampaign.create({
          organization_id, grant_id: grant.id, funder_name: grant.funder, outreach_type,
          subject_line: data.subject_line, message_body: data.message_body, ai_generated: true,
          status: auto_send ? 'sent' : 'ready_to_send', sent_date: auto_send ? new Date().toISOString() : null
        });

        results.saved++;
        if (auto_send && grant.funder_email) {
          try {
            await sdk.integrations.Core.SendEmail({ to: grant.funder_email, from_name: organization.name, subject: data.subject_line, body: data.message_body });
            results.sent++;
          } catch (e) {}
        }
      } catch (e) { results.failed++; }
    }

    return Response.json({ success: true, ...results });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});