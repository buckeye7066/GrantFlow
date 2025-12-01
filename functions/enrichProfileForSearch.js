import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { organization_id } = body;
    if (!organization_id) return Response.json({ success: false, error: 'organization_id required' }, { status: 400 });

    const organization = await base44.entities.Organization.get(organization_id);
    if (!organization) return Response.json({ success: false, error: 'Not found' }, { status: 404 });

    const aiResponse = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: 'Enrich profile for better search results. Name: ' + organization.name + ', Type: ' + organization.applicant_type + ', Mission: ' + organization.mission + '. Generate keywords, focus_areas, program_areas, target_population.',
      response_json_schema: { type: "object", properties: { keywords: { type: "array", items: { type: "string" } }, focus_areas: { type: "array", items: { type: "string" } }, program_areas: { type: "array", items: { type: "string" } }, target_population: { type: "string" }, confidence: { type: "number" } } }
    });

    const enrichedData = {
      keywords: [...(organization.keywords || []), ...(aiResponse.keywords || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 50),
      focus_areas: [...(organization.focus_areas || []), ...(aiResponse.focus_areas || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 20),
      program_areas: [...(organization.program_areas || []), ...(aiResponse.program_areas || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 20),
      target_population: aiResponse.target_population || organization.target_population || ''
    };

    return Response.json({ success: true, enriched_data: enrichedData, improvements: { keywords_added: enrichedData.keywords.length - (organization.keywords?.length || 0) } });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});