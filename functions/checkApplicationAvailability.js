import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { getSafeSDK, assertNotUserSuppliedAuthId, enforceOwnership } from './_shared/security.js';
import { resolveGrantId } from './_utils/resolveEntityId.js';

Deno.serve(async (req) => {
  try {
    const { sdk, user } = await getSafeSDK(req);
    const base44 = createClientFromRequest(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    
    const { grant_id: rawGrantId, force_check } = await req.json();
    assertNotUserSuppliedAuthId('grant_id', rawGrantId, 'checkApplicationAvailability');
    if (!rawGrantId) return Response.json({ error: 'grant_id is required' }, { status: 400 });

    const grant_id = await resolveGrantId(sdk, rawGrantId);
    const grant = await sdk.entities.Grant.get(grant_id);
    enforceOwnership(user, grant, 'created_by');
    
    if (!grant.url) return Response.json({ success: false, error: 'Grant has no URL to check' });

    if (!force_check && grant.application_last_checked) {
      const hoursSince = (Date.now() - new Date(grant.application_last_checked).getTime()) / 3600000;
      if (hoursSince < 6) return Response.json({ success: true, skipped: true, application_status: grant.application_status });
    }

    const aiResponse = await base44.integrations.Core.InvokeLLM({
      prompt: `Check if grant application is open: ${grant.title} at ${grant.url}`,
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { is_open: { type: "boolean" }, status: { type: "string" }, status_message: { type: "string" } } }
    });

    await base44.asServiceRole.entities.Grant.update(grant_id, {
      application_status: aiResponse.status || 'unknown',
      application_status_message: aiResponse.status_message || '',
      application_last_checked: new Date().toISOString()
    });

    return Response.json({ success: true, grant_id, ...aiResponse });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});