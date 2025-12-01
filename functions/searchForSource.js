import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Search for Source - AI-powered funding source lookup
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { source_name, location, organization_id } = body;

    if (!source_name) return Response.json({ error: 'source_name is required' }, { status: 400 });

    const prompt = `Find detailed information about funding source "${source_name}"${location ? ` in ${location}` : ''}.
Return: name, parent_organization, source_type, website_url, scholarship_page_url, contact_email, contact_phone, city, state, zip, service_area, eligibility_tags, focus_areas, typical_award_min, typical_award_max, requires_membership, confidence.`;

    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt,
      add_context_from_internet: true,
      response_json_schema: {
        type: "object",
        properties: { name: { type: "string" }, source_type: { type: "string" }, website_url: { type: "string" }, city: { type: "string" }, state: { type: "string" }, confidence: { type: "number" } }
      }
    });

    if (!aiResponse?.name) return Response.json({ success: false, error: 'Source not found' }, { status: 404 });

    const sourceData = {
      discovered_for_organization_id: organization_id || null, name: aiResponse.name, source_type: aiResponse.source_type || 'other',
      website_url: aiResponse.website_url, city: aiResponse.city, state: aiResponse.state,
      ai_discovered: true, discovery_confidence: aiResponse.confidence || 75, verified: false, active: true
    };

    return Response.json({ success: true, source: sourceData });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});