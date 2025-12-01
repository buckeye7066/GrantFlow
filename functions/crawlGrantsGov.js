import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Crawl Grants.gov - Federal grants crawler
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;

    const prompt = `Search grants.gov for 20 most recent federal grants. Extract: opportunityNumber, title, agencyName, postedDate, closeDate, awardCeiling, awardFloor, description, eligibleApplicants, fundingCategory.`;

    const llm = await sdk.integrations.Core.InvokeLLM({
      prompt, add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { grants: { type: "array", items: { type: "object", properties: { opportunityNumber: { type: "string" }, title: { type: "string" }, agencyName: { type: "string" }, closeDate: { type: "string" } } } } } }
    });

    const grants = llm.grants || [];
    let processed = 0;

    for (const g of grants) {
      if (!g.title) continue;
      const item = {
        source: 'grants_gov', source_id: g.opportunityNumber || `gg_${Date.now()}`, title: g.title,
        sponsor: g.agencyName, url: `https://www.grants.gov/search-results-detail/${g.opportunityNumber}`,
        description_raw: g.description || '', close_date: g.closeDate, funding_type: 'federal_grant', regions: ['USA']
      };
      await sdk.functions.invoke('processCrawledItem', { item });
      processed++;
    }

    return Response.json({ ok: true, result: { status: 'completed', found: grants.length, processed } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});