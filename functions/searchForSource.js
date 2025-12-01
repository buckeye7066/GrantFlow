import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { source_name, location, organization_id } = body;
    if (!source_name) return Response.json({ error: 'source_name required' }, { status: 400 });

    const sdk = base44.asServiceRole;
    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Find detailed info about funding source: "' + source_name + '"' + (location ? ' in ' + location : '') + '. Return JSON with: name, source_type, website_url, contact_email, city, state, zip, eligibility_tags, typical_award_min, typical_award_max.',
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { name: { type: "string" }, source_type: { type: "string" }, website_url: { type: "string" }, contact_email: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" }, eligibility_tags: { type: "array", items: { type: "string" } }, typical_award_min: { type: "number" }, typical_award_max: { type: "number" }, confidence: { type: "number" } } }
    });

    if (!aiResponse?.name) return Response.json({ success: false, error: 'Source not found' }, { status: 404 });

    return Response.json({ success: true, source: { ...aiResponse, discovered_for_organization_id: organization_id, ai_discovered: true, verified: false, active: true } });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});