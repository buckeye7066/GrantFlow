import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Generate Outreach Message - Personalized funder outreach
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const user = await base44.auth.me().catch(() => ({ id: 'system', email: 'system@grantflow.app', full_name: 'System' }));
    const body = await req.json();
    const { organization_id, grant_id, funder_name, outreach_type = 'inquiry' } = body;
    if (!organization_id || !funder_name) return Response.json({ error: 'organization_id and funder_name required' }, { status: 400 });

    const organization = await sdk.entities.Organization.get(organization_id);
    if (!organization) return Response.json({ error: 'Organization not found' }, { status: 404 });

    const grant = grant_id ? await sdk.entities.Grant.get(grant_id) : null;

    const prompt = `Generate personalized ${outreach_type} message to ${funder_name} from ${organization.name}. Mission: ${organization.mission}. Research funder online. Return: subject_line, message_body, key_points, success_probability.`;

    const ai = await sdk.integrations.Core.InvokeLLM({
      prompt, add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { subject_line: { type: "string" }, message_body: { type: "string" }, key_points: { type: "array", items: { type: "string" } }, success_probability: { type: "number" } } }
    });

    await sdk.entities.TimeEntry.create({
      organization_id, user_id: user.id, task_category: 'Writing',
      start_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(), end_at: new Date().toISOString(),
      raw_minutes: 12, rounded_minutes: 12, note: `AI-generated ${outreach_type} to ${funder_name}`, source: 'auto'
    });

    return Response.json({ success: true, subject_line: ai.subject_line, message_body: ai.message_body, key_points: ai.key_points, success_probability: ai.success_probability, minutes_billed: 12 });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});