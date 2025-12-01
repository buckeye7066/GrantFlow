import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Process Opportunity - Maps raw grant data to canonical format
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { rawGrant } = body;
    if (!rawGrant) return Response.json({ ok: false, error: 'Missing rawGrant' }, { status: 400 });
    if (!rawGrant.opportunityId || !rawGrant.opportunityTitle) return Response.json({ ok: false, error: 'Invalid grant data' }, { status: 400 });

    const mappedItem = {
      source: 'grants_gov', source_id: rawGrant.opportunityId, title: rawGrant.opportunityTitle,
      sponsor: rawGrant.agencyName || 'Unknown Agency', url: `https://www.grants.gov/search-results-detail/${rawGrant.opportunityId}`,
      description_raw: rawGrant.description || '', open_date: rawGrant.postDate, close_date: rawGrant.closeDate,
      funding_type: 'grant', award_min: rawGrant.awardFloor, award_max: rawGrant.awardCeiling,
      categories: rawGrant.categories || [], regions: rawGrant.eligibleApplicants || []
    };

    await base44.asServiceRole.functions.invoke('processCrawledItem', { item: mappedItem });
    return Response.json({ success: true, status: 'processed', data: { opportunityId: rawGrant.opportunityId, title: mappedItem.title, source: 'grants_gov' } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});