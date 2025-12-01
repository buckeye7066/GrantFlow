import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Match Grants for Organization - AI-powered grant matching engine
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHENTICATED' }, { status: 401 });

    const body = await req.json();
    const { organization_id, min_score = 60, max_results = 50 } = body;
    if (!organization_id) return Response.json({ ok: false, error: 'organization_id required' }, { status: 400 });

    const organization = await sdk.entities.Organization.get(organization_id);
    if (!organization) return Response.json({ ok: false, error: 'Organization not found' }, { status: 404 });

    const existingGrants = await sdk.entities.Grant.filter({ organization_id });
    const opportunities = await sdk.entities.FundingOpportunity.list('-created_date', 1000);
    const existingUrls = new Set(existingGrants.map(g => g.url).filter(Boolean));

    const scored = [];
    for (const opp of opportunities) {
      if (opp.url && existingUrls.has(opp.url)) continue;
      let score = 50;
      const reasons = [];
      if (organization.applicant_type?.includes('student') && opp.categories?.some(c => c.includes('scholarship'))) { score += 20; reasons.push('Student scholarship'); }
      if ((organization.focus_areas || []).some(f => opp.categories?.includes(f))) { score += 15; reasons.push('Focus area match'); }
      if (organization.state && opp.regions?.includes(organization.state)) { score += 10; reasons.push('Geographic match'); }
      if (score >= min_score) scored.push({ ...opp, match_score: score, match_reasons: reasons });
    }

    scored.sort((a, b) => b.match_score - a.match_score);
    return Response.json({ ok: true, data: { matches: scored.slice(0, max_results), total: scored.length } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});