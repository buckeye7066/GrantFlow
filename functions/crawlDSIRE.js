import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Crawl DSIRE - Energy incentives database crawler
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;

    const opportunities = [
      { source: 'dsire', source_id: 'TN-123', url: 'https://programs.dsireusa.org/system/program/tn123', title: 'TVA Green Power Providers', sponsor: 'Tennessee Valley Authority', description_raw: 'Renewable energy premium payments for solar, wind, hydro.', funding_type: 'rebate', regions: ['US-TN'], categories: ['renewable_energy', 'solar'], awardMax: 5000 },
      { source: 'dsire', source_id: 'US-555', url: 'https://programs.dsireusa.org/system/program/us555', title: 'Residential Clean Energy Credit', sponsor: 'IRS', description_raw: '30% tax credit for solar, wind, geothermal, battery storage.', funding_type: 'credit', regions: ['US'], categories: ['tax_credit', 'renewable_energy'], awardMax: null }
    ];

    let processed = 0;
    for (const item of opportunities) {
      await sdk.functions.invoke('processCrawledItem', { item });
      processed++;
    }

    return Response.json({ status: 'completed', found: opportunities.length, processed });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});