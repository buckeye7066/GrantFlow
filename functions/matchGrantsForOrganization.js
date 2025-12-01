import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHENTICATED' }, { status: 401 });

    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { organization_id, min_score = 60, max_results = 50 } = body;
    if (!organization_id) return Response.json({ ok: false, error: 'organization_id required' }, { status: 400 });

    const organization = await sdk.entities.Organization.get(organization_id);
    if (!organization) return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });

    const existingGrants = await sdk.entities.Grant.filter({ organization_id, profile_id: body.profile_id || organization_id });
    const opportunities = await sdk.entities.FundingOpportunity.list('-created_date', 1000);
    const existingUrls = new Set(existingGrants.map(g => g.url).filter(Boolean));

    const scoredOpps = [];
    for (const opp of opportunities) {
      if (opp.url && existingUrls.has(opp.url)) continue;
      
      let score = 50;
      const reasons = [];
      
      // Basic scoring logic
      if (organization.focus_areas?.some(f => opp.categories?.includes(f))) { score += 20; reasons.push('Focus match'); }
      if (organization.state && opp.regions?.includes(organization.state)) { score += 15; reasons.push('Geographic match'); }
      
      if (score >= min_score) scoredOpps.push({ ...opp, match_score: score, match_reasons: reasons });
    }

    scoredOpps.sort((a, b) => b.match_score - a.match_score);
    const topMatches = scoredOpps.slice(0, max_results);

    return Response.json({ ok: true, success: true, data: { matches: topMatches, total_opportunities_analyzed: opportunities.length } });
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
});