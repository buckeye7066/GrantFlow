import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { organization_id, grant_id, form_fields } = body;
    if (!organization_id) return Response.json({ success: false, error: 'organization_id required' }, { status: 400 });

    const [organization, grant, pastGrants, contacts] = await Promise.all([
      sdk.entities.Organization.get(organization_id),
      grant_id ? sdk.entities.Grant.get(grant_id) : null,
      sdk.entities.Grant.filter({ organization_id, status: { $in: ['awarded', 'submitted'] } }),
      sdk.entities.Contact.filter({ organization_id })
    ]);

    if (!organization) return Response.json({ success: false, error: 'Organization not found' }, { status: 404 });

    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Pre-fill grant application form for: ' + organization.name + '. Mission: ' + organization.mission + '. Form fields: ' + JSON.stringify(form_fields || ['applicant_legal_name', 'ein', 'mission', 'past_projects']),
      response_json_schema: { type: "object", properties: { pre_filled_fields: { type: "object" }, confidence_scores: { type: "object" }, missing_data_warnings: { type: "array", items: { type: "string" } } } }
    });

    return Response.json({ success: true, pre_filled_fields: aiResponse.pre_filled_fields || {}, confidence_scores: aiResponse.confidence_scores || {}, missing_data: aiResponse.missing_data_warnings || [] });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});