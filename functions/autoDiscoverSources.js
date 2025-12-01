import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

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

    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Auto-discover 8-12 funding sources for: ' + profile.name + ' (' + profile.applicant_type + ') in ' + profile.city + ', ' + profile.state + '. Focus: ' + (profile.focus_areas?.join(', ') || 'General') + '. Find local foundations, service clubs, universities, hospitals, etc.',
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { sources: { type: "array", items: { type: "object", properties: { name: { type: "string" }, source_type: { type: "string" }, website_url: { type: "string" }, city: { type: "string" }, state: { type: "string" }, confidence: { type: "number" }, priority: { type: "string" } } } } } }
    });

    const results = { sources_discovered: 0, sources_crawled: 0, campaigns: [] };

    for (const sourceData of (aiResponse.sources || [])) {
      try {
        const existing = await sdk.entities.SourceDirectory.filter({ name: sourceData.name, state: sourceData.state });
        let source = existing[0];
        
        if (!source) {
          source = await sdk.entities.SourceDirectory.create({ discovered_for_organization_id: profileId, profile_id: profileId, name: sourceData.name, source_type: sourceData.source_type, website_url: sourceData.website_url, city: sourceData.city, state: sourceData.state, ai_discovered: true, discovery_confidence: sourceData.confidence || 75 });
          results.sources_discovered++;
        }

        if (sourceData.priority === 'high' && results.sources_crawled < 5) {
          await sdk.functions.invoke('crawlSourceDirectory', { source_id: source.id });
          results.sources_crawled++;
        }
      } catch (e) {}
    }

    return Response.json({ success: true, sources_added: results.sources_discovered, sources_crawled: results.sources_crawled });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});