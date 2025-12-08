import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createLogger } from './_shared/logger.js';

// Base44 integration: Use centralized logger
const logger = createLogger('processSingleGrant');

async function processGrantInternal(sdk, profileId, grantId) {
  const grant = await sdk.entities.Grant.get(grantId);
  if (!grant) return { success: false, error: 'Grant not found' };

  const profile = await sdk.entities.Organization.get(profileId);
  if (!profile) return { success: false, error: 'Profile not found' };

  await sdk.entities.Grant.update(grantId, { ai_status: 'running' });

  let analysis = null;
  try {
    analysis = await sdk.integrations.Core.InvokeLLM({
      prompt: `Analyze grant ${grant.title} for profile ${profile.name}`,
      response_json_schema: { type: "object", properties: { match_score: { type: "number" }, summary: { type: "string" } } }
    });
  } catch (e) { 
    // Base44 integration: Error logging for AI failures
    logger.error('AI analysis failed', { error: e.message });
  }

  const updateData = { ai_status: 'ready', ai_summary: analysis?.summary || 'Done', match_score: analysis?.match_score || 50 };
  if (grant.status === 'discovered' && updateData.match_score >= 60) updateData.status = 'interested';
  await sdk.entities.Grant.update(grantId, updateData);

  return { success: true, data: { grant_id: grantId, profile_id: profileId, match_score: updateData.match_score } };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const { profile_id, grant_id } = await req.json();
    if (!profile_id || !grant_id) return Response.json({ success: false, error: 'Missing profile_id or grant_id' }, { status: 400 });
    return Response.json(await processGrantInternal(sdk, profile_id, grant_id));
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});

export { processGrantInternal };