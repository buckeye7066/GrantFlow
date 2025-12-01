import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Auto Discover Sources - AI-powered local source discovery
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { profile_id, organization_id } = body;
    const profileId = profile_id || organization_id;
    if (!profileId) return Response.json({ success: false, error: 'profile_id required' }, { status: 400 });

    const profile = await sdk.entities.Organization.get(profileId);
    if (!profile) return Response.json({ error: 'Profile not found' }, { status: 404 });

    const prompt = `Discover 8-12 local funding sources for "${profile.name}" in ${profile.city}, ${profile.state}. Type: ${profile.applicant_type}. Include Lions, Rotary, Kiwanis, community foundations, local businesses. Return sources array with name, source_type, website_url, city, state, confidence, priority.`;

    const ai = await sdk.integrations.Core.InvokeLLM({
      prompt, add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { sources: { type: "array", items: { type: "object", properties: { name: { type: "string" }, source_type: { type: "string" }, website_url: { type: "string" }, city: { type: "string" }, state: { type: "string" }, confidence: { type: "number" }, priority: { type: "string" } } } } } }
    });

    let saved = 0;
    for (const s of (ai.sources || [])) {
      const existing = await sdk.entities.SourceDirectory.filter({ name: s.name, state: s.state });
      if (existing.length === 0) {
        await sdk.entities.SourceDirectory.create({ discovered_for_organization_id: profileId, profile_id: profileId, name: s.name, source_type: s.source_type || 'other', website_url: s.website_url, city: s.city, state: s.state, ai_discovered: true, discovery_confidence: s.confidence || 75 });
        saved++;
      }
    }

    return Response.json({ success: true, sources_added: saved, sources_discovered: ai.sources?.length || 0 });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});