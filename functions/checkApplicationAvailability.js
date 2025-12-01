import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { getSafeSDK, enforceOwnership } from './_shared/security.js';
import { resolveGrantId } from './_utils/resolveEntityId.js';

Deno.serve(async (req) => {
  try {
    const { sdk, user } = await getSafeSDK(req);
    const base44 = createClientFromRequest(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { grant_id: rawGrantId, force_check } = await req.json();
    if (!rawGrantId) return Response.json({ error: 'grant_id required' }, { status: 400 });

    const grant_id = await resolveGrantId(sdk, rawGrantId);
    const grant = await sdk.entities.Grant.get(grant_id);
    enforceOwnership(user, grant, 'created_by');

    if (!grant.url) return Response.json({ success: false, error: 'Grant has no URL' });

    const aiResponse = await base44.integrations.Core.InvokeLLM({
      prompt: 'Check if grant application is currently open. Grant: ' + grant.title + ', URL: ' + grant.url + '. Return JSON with: is_open (boolean), status ("open"|"not_yet_open"|"closed"), status_message, opens_date, closes_date.',
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { is_open: { type: "boolean" }, status: { type: "string" }, status_message: { type: "string" }, opens_date: { type: ["string", "null"] }, closes_date: { type: ["string", "null"] } } }
    });

    const updateData = { application_status: aiResponse.status || 'unknown', application_status_message: aiResponse.status_message, application_last_checked: new Date().toISOString() };
    if (aiResponse.status === 'not_yet_open') {
      updateData.notify_when_open = true;
      updateData.application_next_check = new Date(Date.now() + 86400000).toISOString();
    }

    await base44.asServiceRole.entities.Grant.update(grant_id, updateData);

    return Response.json({ success: true, grant_id, application_status: aiResponse.status, is_open: aiResponse.is_open, status_message: aiResponse.status_message });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});