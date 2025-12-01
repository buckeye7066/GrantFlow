import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { grant_id, content } = await req.json();
    if (!grant_id) return Response.json({ error: 'grant_id required' }, { status: 400 });

    const grants = await base44.entities.Grant.filter({ id: grant_id });
    const grant = grants[0];
    const organization = await base44.entities.Organization.get(grant.organization_id);

    const keywordAnalysis = await base44.integrations.Core.InvokeLLM({
      prompt: 'Suggest strategic keywords for grant proposal. Grant: ' + grant.title + ', Funder: ' + grant.funder + '. Organization: ' + organization.name + '. Content: ' + (content || '').substring(0, 500),
      response_json_schema: { type: "object", properties: { primary_keywords: { type: "array", items: { type: "object", properties: { keyword: { type: "string" }, relevance_score: { type: "number" } } } }, secondary_keywords: { type: "array", items: { type: "object" } }, missing_keywords: { type: "array", items: { type: "object" } } } }
    });

    return Response.json({ success: true, analysis: keywordAnalysis });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});