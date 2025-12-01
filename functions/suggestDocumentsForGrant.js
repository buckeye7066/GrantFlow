import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Suggest Documents for Grant - AI-powered document recommendations
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { grant_id, organization_id } = body;
    if (!grant_id || !organization_id) return Response.json({ error: 'grant_id and organization_id required' }, { status: 400 });

    const [grant, organization, allDocs, requirements] = await Promise.all([
      sdk.entities.Grant.get(grant_id),
      sdk.entities.Organization.get(organization_id),
      sdk.entities.Document.filter({ organization_id }),
      sdk.entities.GrantRequirement.filter({ grant_id })
    ]);

    const prompt = `Suggest required documents for grant "${grant.title}" by ${grant.funder}. Organization: ${organization.name}. Existing: ${allDocs.map(d => d.document_type).join(', ')}. Requirements: ${requirements.map(r => r.title).join(', ')}. Return suggestions array with document_name, document_type, required (bool), reason, status (have/missing).`;

    const ai = await sdk.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: { type: "object", properties: { suggestions: { type: "array", items: { type: "object", properties: { document_name: { type: "string" }, document_type: { type: "string" }, required: { type: "boolean" }, reason: { type: "string" }, status: { type: "string" } } } } } }
    });

    const suggestions = (ai.suggestions || []).sort((a, b) => {
      if (a.status === 'missing' && b.status !== 'missing') return -1;
      if (a.required && !b.required) return -1;
      return 0;
    });

    return Response.json({ success: true, suggestions, missing_documents: suggestions.filter(s => s.status === 'missing').length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});