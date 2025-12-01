import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const sdk = createClientFromRequest(req).asServiceRole;
    const allSources = await sdk.entities.SourceDirectory.filter({ active: true });
    
    const now = new Date();
    const sourcesToCrawl = allSources.filter(source => {
      if (!source.last_crawled) return true;
      const intervals = { 'daily': 1, 'weekly': 7, 'monthly': 30, 'quarterly': 90, 'annually': 365 };
      const daysSince = (now - new Date(source.last_crawled)) / (1000 * 60 * 60 * 24);
      return daysSince >= intervals[source.crawl_frequency || 'monthly'];
    });

    if (sourcesToCrawl.length === 0) return Response.json({ success: true, message: 'No sources due' });

    let totalOpportunities = 0;
    const results = [];
    
    for (const source of sourcesToCrawl) {
      try {
        const response = await sdk.functions.invoke('crawlSourceDirectory', { source_id: source.id });
        if (response.data?.success) {
          const saved = response.data.results?.[0]?.opportunities_saved || 0;
          totalOpportunities += saved;
          results.push({ source_name: source.name, success: true, opportunities: saved });
        }
      } catch (e) {
        results.push({ source_name: source.name, success: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    return Response.json({ success: true, sources_crawled: sourcesToCrawl.length, total_opportunities: totalOpportunities, results });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});