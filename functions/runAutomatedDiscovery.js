import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

const log = {
  info: (msg, data = {}) => console.log('[runAutomatedDiscovery] INFO: ' + msg, JSON.stringify(data)),
  warn: (msg, data = {}) => console.warn('[runAutomatedDiscovery] WARN: ' + msg, JSON.stringify(data)),
  error: (msg, data = {}) => console.error('[runAutomatedDiscovery] ERROR: ' + msg, JSON.stringify(data)),
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHENTICATED' }, { status: 401 });
    
    const sdk = base44.asServiceRole;
    const automatedSearches = await sdk.entities.AutomatedSearch.filter({ enabled: true });
    
    let totalOpportunitiesFound = 0;
    let totalGrantsCreated = 0;
    const results = [];

    for (const search of automatedSearches) {
      try {
        const organization = await sdk.entities.Organization.get(search.organization_id);
        if (!organization) continue;

        const searchResponse = await sdk.functions.invoke('searchOpportunities', {
          profile_id: organization.id,
          filters: { faithPreferred: organization.faith_based || false }
        });
        
        const searchData = searchResponse.data?.data || searchResponse.data;
        const opportunities = searchData?.results || searchData?.opportunities || [];
        totalOpportunitiesFound += opportunities.length;

        const minScore = search.min_match_score || 60;
        const qualifiedOpportunities = opportunities.filter(opp => (opp.match || 0) >= minScore);

        let grantsCreated = 0;
        for (const opp of qualifiedOpportunities) {
          const existingGrants = await sdk.entities.Grant.filter({ organization_id: organization.id, url: opp.url });
          if (existingGrants.length > 0) continue;

          const newGrant = await sdk.entities.Grant.create({
            organization_id: organization.id, title: opp.title, funder: opp.sponsor,
            url: opp.url, deadline: opp.deadlineAt, match_score: opp.match, status: 'discovered', ai_status: 'queued'
          });
          
          try { await sdk.functions.invoke('analyzeGrant', { grantId: newGrant.id }); } catch (e) {}
          grantsCreated++;
          totalGrantsCreated++;
        }

        await sdk.entities.AutomatedSearch.update(search.id, { last_run_date: new Date().toISOString(), last_results_count: grantsCreated });
        results.push({ organization_id: organization.id, opportunities_found: opportunities.length, grants_created: grantsCreated });
      } catch (e) {
        results.push({ organization_id: search.organization_id, error: e.message });
      }
    }

    return Response.json({ ok: true, data: { total_opportunities_found: totalOpportunitiesFound, total_grants_created: totalGrantsCreated, results } });
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
});