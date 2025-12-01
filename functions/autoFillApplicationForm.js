import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Auto Fill Application Form - Smart form pre-fill from profile
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { organization_id, grant_id } = body;
    if (!organization_id) return Response.json({ success: false, error: 'organization_id required' }, { status: 400 });

    const [organization, grant, pastGrants, docs] = await Promise.all([
      sdk.entities.Organization.get(organization_id),
      grant_id ? sdk.entities.Grant.get(grant_id) : null,
      sdk.entities.Grant.filter({ organization_id, status: { $in: ['awarded', 'submitted'] } }, '-created_date', 10),
      sdk.entities.Document.filter({ organization_id })
    ]);

    const prompt = `Pre-fill grant application for ${organization.name}. Fields: applicant_legal_name, applicant_ein, address, phone, website, mission, annual_budget. Past grants: ${pastGrants.map(g => g.title).join(', ')}. Return JSON with pre_filled_fields and confidence_scores.`;

    const ai = await sdk.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: { type: "object", properties: { pre_filled_fields: { type: "object" }, confidence_scores: { type: "object" }, missing_data_warnings: { type: "array", items: { type: "string" } } } }
    });

    return Response.json({ success: true, pre_filled_fields: ai.pre_filled_fields || {}, confidence_scores: ai.confidence_scores || {}, missing_data: ai.missing_data_warnings || [] });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});