import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Check Application Compliance - Pre-submission validation
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { grant_id, organization_id, application_data } = body;
    if (!grant_id || !organization_id || !application_data) return Response.json({ error: 'grant_id, organization_id, application_data required' }, { status: 400 });

    const [grant, org, requirements, docs] = await Promise.all([
      sdk.entities.Grant.get(grant_id),
      sdk.entities.Organization.get(organization_id),
      sdk.entities.GrantRequirement.filter({ grant_id }),
      sdk.entities.Document.filter({ grant_id })
    ]);

    const prompt = `Review application for "${grant.title}". Check: missing fields, eligibility, compliance red flags, document gaps. Return: overall_status, compliance_score, critical_issues, warnings, next_steps.`;

    const analysis = await sdk.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: { type: "object", properties: { overall_status: { type: "string" }, compliance_score: { type: "number" }, critical_issues: { type: "array", items: { type: "object" } }, warnings: { type: "array", items: { type: "object" } }, next_steps: { type: "array", items: { type: "string" } } } }
    });

    return Response.json({ success: true, ...analysis });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});