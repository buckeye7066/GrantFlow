import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Search for Item - AI-powered item funding search
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const user = await base44.auth.me();
    if (!user) return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { item_request, profile_id, organization_id, profile_data, distance_miles = 'nationwide' } = body;
    if (!item_request) return Response.json({ success: false, error: 'item_request required' }, { status: 400 });

    const effectiveProfileId = profile_id || organization_id || profile_data?.id;
    if (!effectiveProfileId) return Response.json({ success: false, error: 'profile_id required' }, { status: 400 });

    const profile = profile_data || await sdk.entities.Organization.get(effectiveProfileId);
    if (!profile) return Response.json({ success: false, error: 'Profile not found' }, { status: 404 });

    const prompt = `Find programs that provide "${item_request}" for ${profile.applicant_type} in ${profile.city}, ${profile.state}.
Return JSON with opportunities array containing: program_name, sponsor, category, provides_item_directly, amount_min, amount_max, url, eligibility, description, confidence.`;

    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt, add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { opportunities: { type: "array", items: { type: "object", properties: { program_name: { type: "string" }, sponsor: { type: "string" }, url: { type: "string" } } } } } }
    });

    return Response.json({ success: true, item_request, opportunities: aiResponse.opportunities || [] });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});