import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { source_ids, organization_id } = await req.json();
    if (!source_ids?.length || !organization_id) return Response.json({ error: 'source_ids and organization_id required' }, { status: 400 });

    const sdk = base44.asServiceRole;
    const allSources = await sdk.entities.SourceDirectory.list();
    const sourcesToDelete = allSources.filter(s => source_ids.includes(s.id));

    let opportunitiesDeleted = 0, grantsDeleted = 0;

    for (const source of sourcesToDelete) {
      const opportunities = await sdk.entities.FundingOpportunity.filter({ source: 'source_directory', sponsor: source.name });
      
      if (opportunities.length > 0 || source.name) {
        const oppUrls = opportunities.map(o => o.url).filter(Boolean);
        const grants = await sdk.entities.Grant.filter({ organization_id });
        const grantsToDelete = grants.filter(g => oppUrls.includes(g.url) || g.funder === source.name);
        
        for (const grant of grantsToDelete) {
          await sdk.entities.Grant.delete(grant.id);
          grantsDeleted++;
        }
      }

      for (const opp of opportunities) {
        await sdk.entities.FundingOpportunity.delete(opp.id);
        opportunitiesDeleted++;
      }

      await sdk.entities.SourceDirectory.delete(source.id);
    }

    return Response.json({ success: true, count: sourcesToDelete.length, opportunitiesDeleted, grantsDeleted });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});