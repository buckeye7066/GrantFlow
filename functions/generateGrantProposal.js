import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Generate Grant Proposal - AI-powered proposal writing
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const user = await base44.auth.me();
    if (!user) return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { grant_id, organization_id, section_type, existing_content = '' } = body;
    if (!grant_id || !organization_id) return Response.json({ success: false, error: 'grant_id and organization_id required' }, { status: 400 });

    const [grant, org] = await Promise.all([sdk.entities.Grant.get(grant_id), sdk.entities.Organization.get(organization_id)]);
    if (!grant || !org) return Response.json({ success: false, error: 'Grant or organization not found' }, { status: 404 });

    const prompt = `Write a compelling ${section_type || 'proposal section'} for grant "${grant.title}" by ${grant.funder}.
Organization: ${org.name} (${org.applicant_type}), Mission: ${org.mission || 'N/A'}.
${existing_content ? 'Improve: ' + existing_content : ''}
Write in FIRST PERSON. Return: content, key_messages, word_count.`;

    const result = await sdk.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: { type: "object", properties: { content: { type: "string" }, key_messages: { type: "array", items: { type: "string" } }, word_count: { type: "number" } } }
    });

    await sdk.entities.TimeEntry.create({
      organization_id, user_id: user.id, task_category: 'Writing',
      start_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(), end_at: new Date().toISOString(),
      raw_minutes: 15, rounded_minutes: 15, note: `AI-generated ${section_type} for "${grant.title}"`, source: 'auto'
    });

    return Response.json({ success: true, ...result, metadata: { section_type, billed_minutes: 15 } });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});