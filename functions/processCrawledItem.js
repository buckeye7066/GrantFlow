import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Process Crawled Item - Universal opportunity ingestion
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { item } = body;

    if (!item || !item.source || !item.source_id || !item.title) return Response.json({ ok: false, error: 'Invalid item structure' }, { status: 400 });

    if (item.close_date && !['rolling', 'ongoing', 'open'].includes(String(item.close_date).toLowerCase())) {
      const deadline = new Date(item.close_date);
      if (!isNaN(deadline.getTime()) && deadline < new Date()) {
        return Response.json({ ok: true, result: { status: 'skipped', reason: 'expired' } });
      }
    }

    const existing = await sdk.entities.FundingOpportunity.filter({ source: item.source, source_id: item.source_id });
    const rawDesc = item.description_raw || '';
    let summary = rawDesc.substring(0, 400);

    const oppData = {
      source: item.source, source_id: item.source_id, url: item.url || '', title: item.title,
      sponsor: item.sponsor || 'Unknown', descriptionMd: summary || 'No description',
      eligibilityBullets: item.eligibility_bullets, categories: item.categories, regions: item.regions,
      openedAt: item.open_date, deadlineAt: item.close_date, rolling: item.rolling || false,
      fundingType: item.funding_type || 'grant', awardMin: item.award_min, awardMax: item.award_max,
      lastCrawled: new Date().toISOString()
    };

    const result = existing.length > 0 ? await sdk.entities.FundingOpportunity.update(existing[0].id, oppData) : await sdk.entities.FundingOpportunity.create(oppData);
    return Response.json({ ok: true, result: { status: existing.length > 0 ? 'updated' : 'created', id: result.id } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});