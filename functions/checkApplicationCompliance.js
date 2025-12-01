import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { getSafeSDK, enforceOwnership } from './_shared/security.js';

Deno.serve(async (req) => {
  try {
    const { sdk, user } = await getSafeSDK(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { grant_id, organization_id, application_data } = await req.json();
    if (!grant_id || !organization_id || !application_data) return Response.json({ error: 'grant_id, organization_id, and application_data required' }, { status: 400 });

    const [grant, organization, grantRequirements, budgets, documents] = await Promise.all([
      sdk.entities.Grant.get(grant_id),
      sdk.entities.Organization.get(organization_id),
      sdk.entities.GrantRequirement.filter({ grant_id }),
      sdk.entities.Budget.filter({ grant_id }),
      sdk.entities.Document.filter({ grant_id })
    ]);

    enforceOwnership(user, grant, 'created_by');
    enforceOwnership(user, organization, 'created_by');

    const complianceAnalysis = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Check compliance for grant application. Grant: ' + grant.title + ', Funder: ' + grant.funder + '. Organization: ' + organization.name + '. Application data: ' + JSON.stringify(application_data).substring(0, 1000) + '. Identify missing fields, eligibility issues, compliance red flags.',
      response_json_schema: { type: "object", properties: { overall_status: { type: "string", enum: ["ready", "needs_work", "critical_issues"] }, compliance_score: { type: "number" }, critical_issues: { type: "array" }, warnings: { type: "array" }, missing_fields: { type: "array", items: { type: "string" } }, next_steps: { type: "array", items: { type: "string" } } } }
    });

    return Response.json({ success: true, ...complianceAnalysis, checked_at: new Date().toISOString() });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});