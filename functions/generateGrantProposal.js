import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => ({ id: 'system', email: 'system@grantflow.app' }));
    const body = await req.json();
    const { grant_id, organization_id, section_type } = body;
    
    if (!grant_id || !organization_id) return Response.json({ success: false, error: 'grant_id and organization_id required' }, { status: 400 });

    const sdk = base44.asServiceRole;
    const [grant, organization] = await Promise.all([sdk.entities.Grant.get(grant_id), sdk.entities.Organization.get(organization_id)]);
    if (!grant || !organization) return Response.json({ success: false, error: 'Not found' }, { status: 404 });

    const aiResult = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Write compelling ' + section_type + ' section for grant: ' + grant.title + '. Organization: ' + organization.name + '. Mission: ' + organization.mission,
      response_json_schema: { type: "object", properties: { content: { type: "string" }, key_messages: { type: "array", items: { type: "string" } } } }
    });

    await sdk.entities.TimeEntry.create({
      organization_id, user_id: user.id, task_category: 'Writing',
      start_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(), end_at: new Date().toISOString(),
      raw_minutes: 15, rounded_minutes: 15, note: 'AI-generated ' + section_type, source: 'auto', invoiced: false
    });

    return Response.json({ success: true, ...aiResult, metadata: { section_type, billed_minutes: 15 } });
  } catch (error) {
    return Response.json({ success: false, error: error?.message || 'Failed' }, { status: 500 });
  }
});