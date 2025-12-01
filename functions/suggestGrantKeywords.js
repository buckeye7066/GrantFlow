import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Suggest Grant Keywords - AI keyword and tag suggestions
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { grant_id, organization_id, application_text = '' } = body;
    if (!grant_id) return Response.json({ success: false, error: 'grant_id required' }, { status: 400 });

    const grant = await sdk.entities.Grant.get(grant_id);
    const organization = organization_id ? await sdk.entities.Organization.get(organization_id) : null;

    const prompt = `Suggest keywords for grant "${grant.title}" by ${grant.funder}. Organization: ${organization?.name}. Focus: ${(organization?.focus_areas || []).join(', ')}. Return: primary_keywords, secondary_keywords, strategic_tags, missing_opportunities.`;

    const ai = await sdk.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: { type: "object", properties: { primary_keywords: { type: "array", items: { type: "string" } }, secondary_keywords: { type: "array", items: { type: "string" } }, strategic_tags: { type: "array", items: { type: "string" } }, missing_opportunities: { type: "array", items: { type: "object" } } } }
    });

    const unique = [...new Set([...(ai.primary_keywords || []), ...(ai.secondary_keywords || [])])].slice(0, 20);
    return Response.json({ success: true, keywords: { primary: ai.primary_keywords, secondary: ai.secondary_keywords, all_unique: unique }, tags: ai.strategic_tags, missing_opportunities: ai.missing_opportunities });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});