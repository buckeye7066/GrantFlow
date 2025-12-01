import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Analyze Tax Situation - AI tax optimization with loophole detection
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { organization_id, tax_year } = body;
    if (!organization_id || !tax_year) return Response.json({ error: 'organization_id and tax_year required' }, { status: 400 });

    const organization = await sdk.entities.Organization.get(organization_id);
    const taxDocs = await sdk.entities.TaxDocument.filter({ organization_id, tax_year });
    const profiles = await sdk.entities.TaxProfile.filter({ organization_id, tax_year });
    const profile = profiles[0];

    const prompt = `Analyze tax situation for ${organization.name} in ${tax_year}. Income sources: ${taxDocs.length} documents. Provide deductions, credits, and optimization strategies with estimated savings.`;
    const aiResult = await sdk.integrations.Core.InvokeLLM({
      prompt, add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { recommendations: { type: "array", items: { type: "object", properties: { category: { type: "string" }, estimated_savings: { type: "number" } } } }, total_savings: { type: "number" } } }
    });

    const profileData = {
      organization_id, tax_year, total_income: taxDocs.reduce((s, d) => s + (d.amount || 0), 0),
      ai_recommendations: aiResult.recommendations, estimated_refund: aiResult.total_savings || 0
    };

    const saved = profile ? await sdk.entities.TaxProfile.update(profile.id, profileData) : await sdk.entities.TaxProfile.create(profileData);
    return Response.json({ success: true, tax_profile: saved, recommendations: aiResult.recommendations, total_savings: aiResult.total_savings });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});