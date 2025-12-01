import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Delete Source With Cascade - Removes source and related opportunities/grants
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { source_ids, organization_id } = await req.json();

    if (!source_ids || !Array.isArray(source_ids)) return Response.json({ error: 'source_ids array required' }, { status: 400 });
    if (!organization_id) return Response.json({ error: 'organization_id required' }, { status: 400 });

    const sdk = base44.asServiceRole;
    const allSources = await sdk.entities.SourceDirectory.list();
    const sources = allSources.filter(s => source_ids.includes(s.id));

    let oppsDeleted = 0, grantsDeleted = 0;

    for (const source of sources) {
      const opportunities = await sdk.entities.FundingOpportunity.filter({ source: 'source_directory', sponsor: source.name });
      const oppUrls = opportunities.map(o => o.url).filter(Boolean);
      const grants = await sdk.entities.Grant.filter({ organization_id });
      const toDelete = grants.filter(g => oppUrls.includes(g.url) || g.funder === source.name);

      for (const g of toDelete) { await sdk.entities.Grant.delete(g.id); grantsDeleted++; }
      for (const o of opportunities) { await sdk.entities.FundingOpportunity.delete(o.id); oppsDeleted++; }
      await sdk.entities.SourceDirectory.delete(source.id);
    }

    return Response.json({ success: true, count: sources.length, opportunitiesDeleted: oppsDeleted, grantsDeleted });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});