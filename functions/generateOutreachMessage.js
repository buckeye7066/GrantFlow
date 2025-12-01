import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => ({ id: 'system', email: 'system@grantflow.app', full_name: 'System' }));
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { organization_id, grant_id, funder_name, outreach_type = 'inquiry' } = body;
    if (!organization_id || !funder_name) return Response.json({ error: 'organization_id and funder_name required' }, { status: 400 });

    const organization = await sdk.entities.Organization.get(organization_id);
    const grant = grant_id ? await sdk.entities.Grant.get(grant_id) : null;
    if (!organization) return Response.json({ error: 'Organization not found' }, { status: 404 });

    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Generate personalized ' + outreach_type + ' message to funder: ' + funder_name + '. From: ' + organization.name + ' (' + organization.applicant_type + '). Mission: ' + organization.mission + '. Grant: ' + (grant?.title || 'General inquiry') + '. Research funder and craft compelling message.',
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { subject_line: { type: "string" }, message_body: { type: "string" }, key_points: { type: "array", items: { type: "string" } }, success_probability: { type: "number" } } }
    });

    await sdk.entities.TimeEntry.create({
      organization_id, user_id: user.id, task_category: 'Writing',
      start_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(), end_at: new Date().toISOString(),
      raw_minutes: 12, rounded_minutes: 12, note: 'AI-generated ' + outreach_type + ' for ' + funder_name, source: 'auto', invoiced: false
    });

    return Response.json({ success: true, subject_line: aiResponse.subject_line, message_body: aiResponse.message_body, key_points: aiResponse.key_points || [], success_probability: aiResponse.success_probability || 50, minutes_billed: 12 });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});