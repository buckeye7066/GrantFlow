import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Scheduled Crawl - Automatically crawls sources due for refresh
Deno.serve(async (req) => {
  try {
    const sdk = createClientFromRequest(req).asServiceRole;
    const allSources = await sdk.entities.SourceDirectory.filter({ active: true });
    const now = new Date();

    const intervals = { daily: 1, weekly: 7, monthly: 30, quarterly: 90, annually: 365 };
    const sourcesToCrawl = allSources.filter(source => {
      if (!source.last_crawled) return true;
      const lastCrawled = new Date(source.last_crawled);
      const daysSince = (now - lastCrawled) / (1000 * 60 * 60 * 24);
      return daysSince >= (intervals[source.crawl_frequency] || 30);
    });

    if (sourcesToCrawl.length === 0) return Response.json({ success: true, message: 'No sources due for crawling', sources_crawled: 0 });

    const results = [];
    let totalOpportunities = 0;

    for (const source of sourcesToCrawl.slice(0, 10)) {
      try {
        const response = await sdk.functions.invoke('crawlSourceDirectory', { source_id: source.id });
        const opps = response.data?.results?.[0]?.opportunities_saved || 0;
        totalOpportunities += opps;
        results.push({ source_name: source.name, success: true, opportunities: opps });
      } catch (e) {
        results.push({ source_name: source.name, success: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    const adminUsers = await sdk.entities.User.filter({ role: 'admin' });
    for (const admin of adminUsers) {
      await sdk.integrations.Core.SendEmail({
        to: admin.email,
        subject: `GrantFlow Crawl Complete: ${totalOpportunities} Opportunities`,
        body: `Crawled ${results.length} sources. Found ${totalOpportunities} opportunities.`
      });
    }

    return Response.json({ success: true, sources_crawled: results.length, total_opportunities: totalOpportunities, results });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});