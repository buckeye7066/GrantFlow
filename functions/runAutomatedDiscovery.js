import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Run Automated Discovery - Finds new grants for organizations with active searches
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHENTICATED' }, { status: 401 });

    const sdk = base44.asServiceRole;
    const automatedSearches = await sdk.entities.AutomatedSearch.filter({ enabled: true });

    let totalOpportunities = 0, totalGrantsCreated = 0;
    const results = [];

    for (const search of automatedSearches) {
      try {
        const organization = await sdk.entities.Organization.get(search.organization_id);
        if (!organization) continue;

        const searchResponse = await sdk.functions.invoke('searchOpportunities', { profile_id: organization.id });
        const opportunities = searchResponse.data?.results || [];
        totalOpportunities += opportunities.length;

        const minScore = search.min_match_score || 60;
        const qualified = opportunities.filter(opp => (opp.match || 0) >= minScore);

        let grantsCreated = 0;
        for (const opp of qualified) {
          const existing = await sdk.entities.Grant.filter({ organization_id: organization.id, url: opp.url });
          if (existing.length > 0) continue;

          await sdk.entities.Grant.create({
            organization_id: organization.id, title: opp.title, funder: opp.sponsor,
            url: opp.url, deadline: opp.deadlineAt, match_score: opp.match, status: 'discovered'
          });
          grantsCreated++;
          totalGrantsCreated++;
        }

        await sdk.entities.AutomatedSearch.update(search.id, { last_run_date: new Date().toISOString(), last_results_count: grantsCreated });
        results.push({ organization_id: organization.id, organization_name: organization.name, opportunities_found: opportunities.length, grants_created: grantsCreated });
      } catch (e) {
        results.push({ organization_id: search.organization_id, error: e.message });
      }
    }

    return Response.json({ ok: true, data: { total_opportunities_found: totalOpportunities, total_grants_created: totalGrantsCreated, results } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});