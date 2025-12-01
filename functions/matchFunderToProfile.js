import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { logPHIAccess } from './_shared/phiAuditLogger.js';
import { requiresRepayment } from './_shared/crawlerFramework.js';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const { funder_metadata, organization_id, profile_data, opportunity } = await req.json();

    let profile = profile_data;
    if (!profile && organization_id) profile = await sdk.entities.Organization.get(organization_id);
    if (!profile) return Response.json({ success: false, error: 'Profile not found' }, { status: 400 });

    await logPHIAccess(sdk, { action: 'read', entity: 'Organization', entity_id: profile.id, function_name: 'matchFunderToProfile' });

    if (opportunity) {
      const repayment = requiresRepayment(opportunity);
      if (repayment.requires) return Response.json({ success: true, alignment_score: 0, matched: false, concerns: [repayment.reason] });
    }

    const matchResult = await sdk.integrations.Core.InvokeLLM({
      prompt: `Match profile ${profile.name} to funder. Profile: ${JSON.stringify(profile)}. Funder: ${JSON.stringify(funder_metadata)}`,
      response_json_schema: { type: "object", properties: { alignment_score: { type: "number" }, matched: { type: "boolean" }, reasons: { type: "array", items: { type: "string" } } } }
    });

    return Response.json({ success: true, ...matchResult, profile_id: profile.id, profile_name: profile.name });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});