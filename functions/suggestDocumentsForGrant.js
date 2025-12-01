import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { grant_id, organization_id } = body;
    if (!grant_id || !organization_id) return Response.json({ error: 'grant_id and organization_id required' }, { status: 400 });

    const [grant, organization, allOrgDocs, requirements] = await Promise.all([
      base44.entities.Grant.get(grant_id),
      base44.entities.Organization.get(organization_id),
      base44.entities.Document.filter({ organization_id }),
      base44.entities.GrantRequirement.filter({ grant_id })
    ]);

    const aiResponse = await base44.integrations.Core.InvokeLLM({
      prompt: 'Analyze grant and suggest required documents. Grant: ' + grant.title + ', Funder: ' + grant.funder + ', Award: $' + grant.award_ceiling + '. Organization: ' + organization.name + ' (' + organization.applicant_type + '). Existing docs: ' + allOrgDocs.length + '. Return JSON with suggestions array.',
      response_json_schema: { type: "object", properties: { suggestions: { type: "array", items: { type: "object", properties: { document_name: { type: "string" }, document_type: { type: "string" }, required: { type: "boolean" }, reason: { type: "string" }, status: { type: "string" } } } } } }
    });

    const suggestions = (aiResponse.suggestions || []).sort((a, b) => {
      if (a.status === 'missing' && b.status !== 'missing') return -1;
      if (a.required && !b.required) return -1;
      return 0;
    });

    const readinessScore = suggestions.length === 0 ? 100 : Math.round((suggestions.filter(s => s.status === 'have').length / suggestions.length) * 100);

    return Response.json({ success: true, total_suggestions: suggestions.length, missing_documents: suggestions.filter(s => s.status === 'missing').length, suggestions, readiness_score: readinessScore });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});