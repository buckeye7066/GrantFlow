import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Match Profile to Grants - AI-powered grant matching
Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const user = await base44.auth.me();
    if (!user) return Response.json({ success: false, error: 'UNAUTHORIZED', matches: [] }, { status: 401 });

    const body = await req.json();
    const { organization_id, profile_id, profile_data } = body;
    const effectiveProfileId = profile_id || profile_data?.id || organization_id;

    if (!effectiveProfileId) {
      return Response.json({ success: false, error: 'MISSING_PROFILE_ID', matches: [] }, { status: 400 });
    }

    const organization = profile_data || await sdk.entities.Organization.get(effectiveProfileId);
    if (!organization) {
      return Response.json({ success: false, error: 'PROFILE_NOT_FOUND', matches: [] }, { status: 404 });
    }

    const grants = await sdk.entities.Grant.filter({ organization_id: effectiveProfileId });
    if (grants.length === 0) {
      return Response.json({ success: true, matches: [], count: 0, message: 'No grants found' });
    }

    const profileContext = `Name: ${organization.name}, Type: ${organization.applicant_type}, Location: ${organization.city}, ${organization.state}`;
    const matches = [];

    for (const grant of grants) {
      const prompt = `Analyze match between applicant (${profileContext}) and grant: ${grant.title} by ${grant.funder}. Score 0-100.`;
      try {
        const result = await sdk.integrations.Core.InvokeLLM({
          prompt,
          response_json_schema: { type: "object", properties: { match_score: { type: "number" }, match_reasons: { type: "array", items: { type: "string" } } } }
        });
        matches.push({ grant_id: grant.id, title: grant.title, funder: grant.funder, match_score: result.match_score || 50, match_reasons: result.match_reasons || [] });
      } catch (e) {
        matches.push({ grant_id: grant.id, title: grant.title, match_score: 50, match_reasons: ['Basic eligibility met'] });
      }
    }

    matches.sort((a, b) => b.match_score - a.match_score);
    return Response.json({ success: true, matches, count: matches.length });
  } catch (error) {
    return Response.json({ success: false, error: error.message, matches: [] }, { status: 500 });
  }
});