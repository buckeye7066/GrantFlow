import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { logPHIAccess } from './_shared/phiAuditLogger.js';

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { grant_id, organization_id, application_text = '' } = body;
    if (!grant_id) return Response.json({ success: false, error: 'grant_id required' }, { status: 400 });

    const grant = await sdk.entities.Grant.get(grant_id);
    const organization = organization_id ? await sdk.entities.Organization.get(organization_id) : null;
    if (!grant) return Response.json({ success: false, error: 'Grant not found' }, { status: 400 });

    await logPHIAccess(sdk, { user: null, action: 'read', entity: 'Grant', entity_id: grant_id, function_name: 'suggestGrantKeywords' });

    const suggestions = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Suggest keywords for grant application. Grant: ' + grant.title + ', Funder: ' + grant.funder + '. Organization: ' + (organization?.name || 'Unknown') + '. Mission: ' + (organization?.mission || 'N/A') + '. Application text: ' + application_text.substring(0, 500),
      response_json_schema: { type: "object", properties: { primary_keywords: { type: "array", items: { type: "string" } }, secondary_keywords: { type: "array", items: { type: "string" } }, strategic_tags: { type: "array", items: { type: "string" } } } }
    });

    const allKeywords = [...(suggestions.primary_keywords || []), ...(suggestions.secondary_keywords || [])];
    return Response.json({ success: true, keywords: { primary: suggestions.primary_keywords || [], secondary: suggestions.secondary_keywords || [], all_unique: [...new Set(allKeywords)].slice(0, 20) }, tags: suggestions.strategic_tags || [] });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});