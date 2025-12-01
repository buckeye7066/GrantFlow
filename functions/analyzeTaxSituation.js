// NOTE: Very large file (671 lines) with complex tax logic - minified
import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { organization_id, tax_year } = body;
    if (!organization_id || !tax_year) return Response.json({ error: 'organization_id and tax_year required' }, { status: 400 });

    const organization = await base44.entities.Organization.get(organization_id);
    const taxDocuments = await base44.entities.TaxDocument.filter({ organization_id, tax_year });
    
    // AI analysis for standard deductions + advanced loopholes
    const recommendations = await base44.integrations.Core.InvokeLLM({
      prompt: 'Analyze tax situation and find ALL deductions/credits including advanced loopholes for: ' + organization.name,
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { recommendations: { type: "array" }, total_estimated_savings: { type: "number" } } }
    });

    const loopholes = await base44.integrations.Core.InvokeLLM({
      prompt: 'Find advanced tax loopholes with SPECIFIC maximization tips',
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { loopholes: { type: "array" }, total_potential_savings: { type: "number" } } }
    });

    // Save tax profile
    const profileData = { organization_id, tax_year, ai_recommendations: [...recommendations.recommendations, ...loopholes.loopholes] };
    const saved = await base44.entities.TaxProfile.create(profileData);

    return Response.json({ success: true, tax_profile: saved, total_potential_savings: recommendations.total_estimated_savings + loopholes.total_potential_savings });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});