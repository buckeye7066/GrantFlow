import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Enrich Profile for Search - Auto-generate keywords and focus areas
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { organization_id } = body;
    if (!organization_id) return Response.json({ success: false, error: 'organization_id required' }, { status: 400 });

    const organization = await base44.entities.Organization.get(organization_id);
    if (!organization) return Response.json({ success: false, error: 'Organization not found' }, { status: 404 });

    const prompt = `Analyze profile "${organization.name}" (${organization.applicant_type}). Mission: ${organization.mission}. Generate: keywords (15-25), focus_areas (5-10), program_areas (5-10), target_population (1-2 sentences).`;

    const ai = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: { type: "object", properties: { keywords: { type: "array", items: { type: "string" } }, focus_areas: { type: "array", items: { type: "string" } }, program_areas: { type: "array", items: { type: "string" } }, target_population: { type: "string" } } }
    });

    const enriched = {
      keywords: [...(organization.keywords || []), ...(ai.keywords || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 50),
      focus_areas: [...(organization.focus_areas || []), ...(ai.focus_areas || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 20),
      program_areas: [...(organization.program_areas || []), ...(ai.program_areas || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 20),
      target_population: ai.target_population || organization.target_population
    };

    return Response.json({ success: true, enriched_data: enriched, improvements: { keywords_added: enriched.keywords.length - (organization.keywords?.length || 0) } });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});