import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Discover Local Sources - AI-powered local funding source discovery
Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const user = await base44.auth.me();
    if (!user) return Response.json({ success: false, error: 'UNAUTHORIZED', discovered_sources: [] }, { status: 401 });

    const body = await req.json();
    const { profile_id, organization_id, profile_data, additional_zip_codes = [], additional_cities = [] } = body;
    const effectiveProfileId = profile_id || profile_data?.id || organization_id;

    if (!effectiveProfileId) return Response.json({ success: false, error: 'MISSING_PROFILE_ID', discovered_sources: [] }, { status: 400 });

    const organization = profile_data || await sdk.entities.Organization.get(effectiveProfileId);
    if (!organization) return Response.json({ success: false, error: 'PROFILE_NOT_FOUND', discovered_sources: [] }, { status: 404 });

    const searchAreas = [`${organization.city}, ${organization.state}`, ...additional_cities, ...additional_zip_codes.map(z => `ZIP ${z}`)];
    const specialCircumstances = [];
    if (organization.first_generation) specialCircumstances.push('first-generation');
    if (organization.low_income) specialCircumstances.push('low-income');
    if (organization.veteran) specialCircumstances.push('veteran');

    const prompt = `Find local funding sources for ${organization.applicant_type} in ${searchAreas.join(', ')}.
Circumstances: ${specialCircumstances.join(', ') || 'None'}.
Focus: ${organization.focus_areas?.join(', ') || 'General'}.
Return JSON with discovered_sources array containing name, source_type, website_url, city, state, eligibility_focus, confidence_score.`;

    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt,
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { discovered_sources: { type: "array", items: { type: "object", properties: { name: { type: "string" }, source_type: { type: "string" }, website_url: { type: "string" }, city: { type: "string" }, state: { type: "string" }, eligibility_focus: { type: "string" }, confidence_score: { type: "number" } } } } } }
    });

    const sources = (aiResponse.discovered_sources || []).filter(s => s.name && s.website_url?.startsWith('http'));
    let savedCount = 0;

    for (const source of sources) {
      try {
        await sdk.entities.SourceDirectory.create({
          name: source.name, source_type: source.source_type || 'local_foundation', website_url: source.website_url,
          city: source.city || organization.city, state: source.state || organization.state,
          discovered_for_organization_id: organization.id, ai_discovered: true, discovery_confidence: source.confidence_score, active: true
        });
        savedCount++;
      } catch (e) { console.warn('Failed to save source:', source.name); }
    }

    return Response.json({ success: true, sources_added: savedCount, discovered_sources: sources, profileIdUsed: effectiveProfileId });
  } catch (error) {
    return Response.json({ success: false, error: error.message, discovered_sources: [] }, { status: 500 });
  }
});