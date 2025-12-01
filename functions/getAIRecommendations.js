import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

const log = { info: (s, d = {}) => console.log('[getAIRecommendations] INFO: ' + s, JSON.stringify(d)), error: (s, d = {}) => console.error('[getAIRecommendations] ERROR: ' + s, JSON.stringify(d)) };

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHENTICATED' }, { status: 401 });

    const body = await req.json();
    const { profileId } = body;
    if (!profileId) return Response.json({ ok: false, error: 'Profile ID required' }, { status: 400 });

    const sdk = base44.asServiceRole;
    const profile = await sdk.entities.Organization.get(profileId);
    if (!profile) return Response.json({ ok: false, error: 'Profile not found' }, { status: 404 });

    const pastGrants = await sdk.entities.Grant.filter({ organization_id: profileId });
    const opportunities = await sdk.entities.FundingOpportunity.list('-created_date', 500);

    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Recommend top 5 funding opportunities for ' + profile.name + '. Profile: ' + JSON.stringify({ name: profile.name, mission: profile.mission, focusAreas: profile.focus_areas }),
      response_json_schema: { type: 'object', properties: { recommendations: { type: 'array', items: { type: 'object', properties: { opportunityId: { type: 'string' }, title: { type: 'string' }, sponsor: { type: 'string' }, matchScore: { type: 'number' }, aiReason: { type: 'string' } } } } } }
    });

    return Response.json({ ok: true, data: { recommendations: aiResponse.recommendations || [] } });
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
});